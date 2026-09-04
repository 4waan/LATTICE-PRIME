// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SeamJournal} from "../src/observatory/SeamJournal.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {DisclosureLattice} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget} from "../src/lattice/DisclosureBudget.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";

/// A registry that reverts. an invariant' has to survive it, because ATS turns a
/// revert at seam C into a reverted transfer, not into a denial.
contract RevertingRegistry is IExternalKycList {
    function getKycStatus(address) external pure returns (IKyc.KycStatus) {
        revert("nope");
    }
}

/// A registry that answers in the wrong shape. `try/catch` alone would decode
/// the first 32 bytes of this and believe it.
contract WideRegistry {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1), uint256(1));
    }
}

/// @notice Seam C and seam C-prime.
///
/// The census says the venue was one seam short: seam D never sees the
/// controller rail, the maturity rail, or hold creation. These tests exercise
/// the contract that closes what can be closed, and pin the shapes ATS actually
/// sends, which are not the shapes the interface declares.
contract SeamJournalTest is Test {
    SeamJournal journal;
    ZkKycRegistry registry;

    address constant ADMIN = address(0xAD1);
    address constant TOKEN = address(0x707);
    address constant GATE = address(0x6A7E);
    address constant ALICE = address(0xA11CE);
    address constant MALLORY = address(0x4A110);

    uint64 constant EPOCH_ZERO = 1_000;
    uint64 constant EPOCH_LEN = 100;

    /// Permissive: exact figures may be published immediately.
    uint32 permissive;
    /// Tight: nothing finer than a predicate, and nothing before end of day.
    uint32 tight;

    function _row() internal pure returns (DisclosureBudget.Row memory) {
        // The four numbers `docs/OUTLINE.md` 5.2 records as missing. Stated here
        // for a notional row: 32 bits of domain, an aggregate carrying 8, a
        // sixteen-bucket scale carrying 4, and a coalition budget of 6.
        return DisclosureBudget.Row({
            domainBits: 32, aggBits: 8, bucketBits: 16, budgetBits: 20
        });
    }

    function setUp() public {
        vm.warp(EPOCH_ZERO + 5 * EPOCH_LEN);
        registry = new ZkKycRegistry(ADMIN, EPOCH_ZERO, EPOCH_LEN);
        vm.prank(ADMIN);
        registry.bootstrapGate(GATE);
        vm.prank(GATE);
        registry.grant(ALICE, keccak256("alice"));

        permissive = DisclosureLattice.point(
            DisclosureLattice.G_EXACT, DisclosureLattice.T_IMM
        );
        tight = DisclosureLattice.point(
            DisclosureLattice.G_PRED, DisclosureLattice.T_EOD
        );

        journal = new SeamJournal(
            ADMIN, TOKEN, address(registry), EPOCH_ZERO, EPOCH_LEN, permissive, _row()
        );
    }

    // ------------------------------------------------ seam C, the shapes

    /// `_validateSenderCompliance` sends `(sender, address(0), 0)`. The declared
    /// parameters are not the ones sent. A journal that read that as "a transfer
    /// of zero to the zero address" would deny every operator transfer.
    function test_operatorProbeShapeIsNotATransfer() public view {
        assertTrue(journal.canTransfer(ALICE, address(0), 0), "granted operator");
        assertFalse(journal.canTransfer(MALLORY, address(0), 0), "ungranted operator");
    }

    /// The hold execution rail sends `(address(0), to, 0)`. The held amount is
    /// withheld, so a size policy is blind here and must not read the zero as
    /// small. Only the recipient is judged.
    function test_holdExecutionProbeJudgesOnlyTheRecipient() public view {
        assertTrue(journal.canTransfer(address(0), ALICE, 0), "granted recipient");
        assertFalse(journal.canTransfer(address(0), MALLORY, 0), "ungranted recipient");
    }

    function test_realTransferJudgesBothSides() public {
        assertFalse(journal.canTransfer(ALICE, MALLORY, 1e18), "recipient ungranted");
        vm.prank(GATE);
        registry.grant(MALLORY, keccak256("mallory"));
        assertTrue(journal.canTransfer(ALICE, MALLORY, 1e18), "both granted");
    }

    function test_explainNamesTheSideThatFailed() public view {
        (bool ok, uint8 why) = journal.explain(ALICE, MALLORY, 1e18);
        assertFalse(ok);
        assertEq(why, 1, "recipient not granted");
    }

    // -------------------------------------------------------- an invariant'

    /// A revert here does not fail open, it bricks the token: ATS wraps the
    /// staticcall and re-reverts. So the journal must absorb a registry that
    /// reverts and answer false.
    function test_canTransferSurvivesARevertingRegistry() public {
        SeamJournal j = new SeamJournal(
            ADMIN, TOKEN, address(new RevertingRegistry()),
            EPOCH_ZERO, EPOCH_LEN, permissive, _row()
        );
        assertFalse(j.canTransfer(ALICE, MALLORY, 1), "denied, not reverted");
    }

    /// And a registry that answers with the right first word and the wrong
    /// length. Length is checked before the decode for exactly this case.
    function test_canTransferRejectsAWrongShapedAnswer() public {
        SeamJournal j = new SeamJournal(
            ADMIN, TOKEN, address(new WideRegistry()),
            EPOCH_ZERO, EPOCH_LEN, permissive, _row()
        );
        assertFalse(j.canTransfer(ALICE, MALLORY, 1), "64 bytes is not a status");
    }

    /// An address the registry has never seen is denied by the zero value, not
    /// by a branch. Same defence as an invariant one seam over.
    function test_unknownAddressIsDeniedByDefault() public view {
        assertFalse(journal.canTransfer(ALICE, address(0xDEAD), 1), "default deny");
    }

    // ------------------------------------------ seam C-prime, the inference

    /// The finding, executable. A transfer arrives at an address holding no live
    /// grant. Seam D denies by default, so no path that consulted seam D could
    /// have produced this notification. Therefore the transfer came in on a rail
    /// that skipped it, and the journal says so without naming the rail.
    function test_anArrivalAtAnUngrantedAddressIsFlagged() public {
        uint64 e = journal.currentEpoch();
        // 500e18 is 5 * 10^20, so twenty decades. The magnitude goes out, the
        // figure does not.
        vm.expectEmit(true, true, true, true);
        emit SeamJournal.UnverifiedArrival(MALLORY, 20, e);
        vm.prank(TOKEN);
        journal.transferred(ALICE, MALLORY, 500e18);

        SeamJournal.EpochRecord memory r = journal.epochRecord(e);
        assertEq(r.unverifiedArrivals, 1, "flagged");
        assertEq(r.transfers, 1, "counted");
    }

    /// The contrast. An arrival at a granted address is ordinary traffic and
    /// raises nothing, so the flag means something when it does fire.
    function test_anArrivalAtAGrantedAddressIsNotFlagged() public {
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.transferred(MALLORY, ALICE, 1e18);
        SeamJournal.EpochRecord memory r = journal.epochRecord(e);
        assertEq(r.unverifiedArrivals, 0, "not flagged");
        assertEq(r.transfers, 1, "still counted");
    }

    /// A grant that has aged out of its epoch reads as no grant, so an arrival
    /// at a stale holder is flagged. an invariant is enforced at read time and the
    /// journal inherits it rather than restating it.
    function test_aStaleGrantIsNotAGrant() public {
        vm.warp(block.timestamp + EPOCH_LEN);
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.transferred(MALLORY, ALICE, 1e18);
        assertEq(journal.epochRecord(e).unverifiedArrivals, 1, "stale grant flagged");
    }

    function test_issuanceToAnUngrantedAddressIsFlagged() public {
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.created(MALLORY, 10e18);
        SeamJournal.EpochRecord memory r = journal.epochRecord(e);
        assertEq(r.issues, 1);
        assertEq(r.unverifiedArrivals, 1);
    }

    /// Redemption has no recipient, so there is no arrival to test. It is
    /// counted and nothing is flagged, which is the right answer and not a gap:
    /// the census says the maturity rail does consult seam D.
    function test_redemptionIsCountedAndNotFlagged() public {
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.destroyed(ALICE, 7e18);
        SeamJournal.EpochRecord memory r = journal.epochRecord(e);
        assertEq(r.redemptions, 1);
        assertEq(r.grossOut, 7e18);
        assertEq(r.unverifiedArrivals, 0);
    }

    /// The write side is a full CALL from the token and anyone can make one. A
    /// forged notification is a forged audit record, and the audit record is the
    /// product, so this is the one place the journal reverts.
    function test_onlyTheTokenMayWriteTheJournal() public {
        vm.expectRevert(SeamJournal.NotToken.selector);
        journal.transferred(ALICE, MALLORY, 1);
        vm.expectRevert(SeamJournal.NotToken.selector);
        journal.created(MALLORY, 1);
        vm.expectRevert(SeamJournal.NotToken.selector);
        journal.destroyed(ALICE, 1);
    }

    // ------------------------------------------------------ an invariant, policy

    /// A ceiling of "nothing finer than a predicate, and nothing before end of
    /// day" forbids both public forms, because `(pred, imm)` is not under
    /// `(pred, EOD)`: the time axis runs the other way and an immediate
    /// disclosure is strictly stronger than a deferred one. So nothing is
    /// emitted at all, the transfer still succeeds, and the arrival is still
    /// recorded where a supervisor can read it.
    ///
    /// This is the case the lattice exists to get right. A model carrying only
    /// granularity would have called `pred` permitted and published.
    function test_aCeilingDeferredToEndOfDayPublishesNothingImmediately() public {
        SeamJournal j = new SeamJournal(
            ADMIN, TOKEN, address(registry), EPOCH_ZERO, EPOCH_LEN, tight, _row()
        );
        uint64 e = j.currentEpoch();
        vm.recordLogs();
        vm.prank(TOKEN);
        j.transferred(ALICE, MALLORY, 500e18);
        assertEq(vm.getRecordedLogs().length, 0, "nothing public");
        assertEq(j.epochRecord(e).unverifiedArrivals, 1, "still recorded in full");
        assertEq(j.spentBits(e), 0, "and nothing spent");
    }

    /// A ceiling that permits the fact immediately but not the magnitude falls
    /// back to the withheld form rather than dropping the record.
    function test_aPredicateCeilingWithholdsTheMagnitude() public {
        uint32 predNow = DisclosureLattice.point(
            DisclosureLattice.G_PRED, DisclosureLattice.T_IMM
        );
        SeamJournal j = new SeamJournal(
            ADMIN, TOKEN, address(registry), EPOCH_ZERO, EPOCH_LEN, predNow, _row()
        );
        uint64 e = j.currentEpoch();
        vm.expectEmit(true, true, true, true);
        emit SeamJournal.UnverifiedArrivalWithheld(MALLORY, e);
        vm.prank(TOKEN);
        j.transferred(ALICE, MALLORY, 500e18);
        assertEq(j.spentBits(e), 1, "one bit, the predicate");
    }

    /// The theorem the design rests on. `requireWellFormed` demands
    /// `budgetBits < domainBits`, and an exact disclosure costs exactly
    /// `domainBits`. So no well formed row can ever afford one, whatever the
    /// ceiling says, and a public event carrying an exact figure would be
    /// unreachable code. That is why `UnverifiedArrival` carries a bucket.
    ///
    /// Asserted over a fuzzed row rather than an example, because the claim is
    /// universal and an example would not be evidence for it.
    function testFuzz_aWellFormedBudgetCanNeverAffordAnExactDisclosure(
        uint16 domainBits,
        uint16 aggBits,
        uint16 bucketBits,
        uint16 budgetBits
    ) public pure {
        domainBits = uint16(bound(domainBits, 2, 4096));
        aggBits = uint16(bound(aggBits, 1, domainBits));
        bucketBits = uint16(bound(bucketBits, aggBits, domainBits));
        budgetBits = uint16(bound(budgetBits, 0, domainBits - 1));
        DisclosureBudget.Row memory r = DisclosureBudget.Row({
            domainBits: domainBits,
            aggBits: aggBits,
            bucketBits: bucketBits,
            budgetBits: budgetBits
        });
        DisclosureBudget.requireWellFormed(r);
        assertGt(
            DisclosureBudget.bits(r, DisclosureBudget.G_EXACT),
            r.budgetBits,
            "exact always exceeds a binding budget"
        );
    }

    /// The budget binds within an epoch. Sixteen bits of bucket against a
    /// twenty bit budget affords one disclosure and not two, so the second
    /// arrival falls back to the predicate and the third goes out silent.
    function test_theBudgetBindsWithinAnEpoch() public {
        uint64 e = journal.currentEpoch();
        vm.startPrank(TOKEN);
        journal.transferred(ALICE, MALLORY, 1e18);
        assertEq(journal.spentBits(e), 16, "first: the magnitude");
        journal.transferred(ALICE, MALLORY, 2e18);
        assertEq(journal.spentBits(e), 17, "second: the predicate only");
        journal.transferred(ALICE, MALLORY, 3e18);
        journal.transferred(ALICE, MALLORY, 4e18);
        journal.transferred(ALICE, MALLORY, 5e18);
        assertEq(journal.spentBits(e), 20, "budget reached");
        vm.recordLogs();
        journal.transferred(ALICE, MALLORY, 6e18);
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0, "spent: nothing further goes out");
        assertEq(journal.epochRecord(e).unverifiedArrivals, 6, "all six recorded");
    }

    /// The budget is per epoch and resets with it, because the coalition it
    /// bounds is the set of observers of that epoch's row.
    function test_theBudgetResetsWithTheEpoch() public {
        vm.prank(TOKEN);
        journal.transferred(ALICE, MALLORY, 1e18);
        vm.warp(block.timestamp + EPOCH_LEN);
        assertEq(journal.spentBits(journal.currentEpoch()), 0, "fresh budget");
    }

    /// A row whose bucket count cannot name every decade of a `uint128` is
    /// refused, because `_bucket` would then disclose more than the budget is
    /// charging for and the bound would be certified without holding.
    function test_aBucketScaleTooCoarseForTheDomainIsRefused() public {
        vm.expectRevert();
        new SeamJournal(
            ADMIN, TOKEN, address(registry), EPOCH_ZERO, EPOCH_LEN, permissive,
            DisclosureBudget.Row({
                domainBits: 32, aggBits: 2, bucketBits: 5, budgetBits: 20
            })
        );
    }

    // ------------------------------------------------------------ epochs

    /// The epoch aggregate is what a supervisor reads. It is published only once
    /// the epoch has closed, so the disclosure sits at `T_EPOCH` and not before.
    function test_anOpenEpochDisclosesNothing() public {
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.transferred(MALLORY, ALICE, 3e18);
        vm.recordLogs();
        journal.disclose(e);
        assertEq(vm.getRecordedLogs().length, 0, "open epoch stays closed");
    }

    function test_aClosedEpochDisclosesUnderTheCeiling() public {
        uint64 e = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.transferred(MALLORY, ALICE, 3e18);
        vm.warp(block.timestamp + EPOCH_LEN);
        vm.recordLogs();
        journal.disclose(e);
        assertEq(vm.getRecordedLogs().length, 1, "one disclosure");
    }

    /// Counters are per epoch and do not carry over, so a supervisor reading
    /// epoch `n` is reading epoch `n` and not a running total.
    function test_countersDoNotBleedAcrossEpochs() public {
        uint64 first = journal.currentEpoch();
        vm.prank(TOKEN);
        journal.transferred(ALICE, MALLORY, 1e18);
        vm.warp(block.timestamp + EPOCH_LEN);
        uint64 second = journal.currentEpoch();
        assertEq(second, first + 1);
        assertEq(journal.epochRecord(second).transfers, 0, "fresh epoch");
        assertEq(journal.epochRecord(first).transfers, 1, "first epoch intact");
    }

    // -------------------------------------------------------------- fuzz

    /// an invariant' as a property rather than three examples: no argument triple
    /// makes `canTransfer` revert.
    function testFuzz_canTransferNeverReverts(address from, address to, uint256 amount)
        public
        view
    {
        journal.canTransfer(from, to, amount);
    }

    /// A holder the registry has granted is accepted whatever the size, because
    /// this journal's policy is eligibility and not notional. Stated as a test
    /// so that adding a size rule later is a visible change of policy.
    function testFuzz_sizeDoesNotAffectAGrantedPair(uint256 amount) public {
        vm.prank(GATE);
        registry.grant(MALLORY, keccak256("m2"));
        assertTrue(journal.canTransfer(ALICE, MALLORY, amount));
    }
}
