// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Rulebook} from "../src/observatory/Rulebook.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {AxeBoard, ISealedOrderBook, IRespondentRegistry} from "../src/market/AxeBoard.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {MockHolds} from "./Repo.t.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @notice A tariff source whose number can move after publication.
contract MovableSource {
    uint256 private _v;

    constructor(uint256 v) {
        _v = v;
    }

    function value() external view returns (uint256) {
        return _v;
    }

    function set(uint256 v) external {
        _v = v;
    }
}

/// @notice Answers nothing.
contract RevertingSource {
    function value() external pure returns (uint256) {
        revert("no");
    }
}

/// @notice Answers half a word. Not a `uint256`.
contract ShortSource {
    fallback() external {
        assembly {
            return(0, 0x10)
        }
    }
}

/// @notice Answers with a megabyte in front of the word.
contract BombSource {
    fallback() external {
        assembly {
            return(0, 0x100000)
        }
    }
}

/// @notice Never answers.
contract HungrySource {
    fallback() external {
        assembly {
            for {} 1 {} {}
        }
    }
}

/// @notice A getter that writes. Legal to call, illegal under `staticcall`.
contract WritingSource {
    uint256 public calls;

    function value() external returns (uint256) {
        calls += 1;
        return 1;
    }
}

/// @title RulebookTest
/// @notice The published rulebook, the tariff, and the claims in the document
///         that can be falsified by the code.
contract RulebookTest is Test, PolicyFixture {
    Rulebook internal book_;
    OrderBook internal orders;
    AxeBoard internal axes;
    RepoVault internal vault;

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint256 internal constant COMMIT_BOND = 0.1 ether;
    uint256 internal constant CANCEL_FEE =
        (COMMIT_BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);
    uint64 internal constant ROUND = 1 days;
    uint64 internal constant REST = 7;

    uint256 internal constant PROBE_FEE = 0.01 ether;
    uint32 internal constant MAX_OUT = 4;
    uint256 internal constant AXE_BOND = MAX_OUT * (COMMIT_BOND - PROBE_FEE) + 1;
    uint64 internal constant ANSWER = 1 hours;
    uint64 internal constant OSR = 4 hours;

    address internal constant ANYONE = address(0xA11);

    /// @dev 0.10 bp a day. Section 8 says why the number is published rather
    ///      than derived, and `RepoVault.penaltyRate` says it again in code.
    uint256 internal constant PENALTY_RATE = 10;

    /// @notice keccak256 of `docs/RULEBOOK.md`, byte for byte.
    /// @dev Recorded here rather than computed, so editing the document without
    ///      republishing fails the build instead of passing silently. The failure
    ///      prints the hash to paste back.
    bytes32 internal constant DOCUMENT =
        0xd3596823cf96b51ee24b9738823374547f27480650f01029b15499c85fbf6fed;

    /// @dev The getters section 8 names. A wrong one cannot survive `setUp`:
    ///      `adopt` reads every sourced line back and refuses a mismatch.
    bytes4 internal constant COMMIT_BOND_READER = bytes4(keccak256("commitBond()"));
    bytes4 internal constant CANCEL_FEE_READER = bytes4(keccak256("cancelFee()"));
    bytes4 internal constant AXE_BOND_READER = bytes4(keccak256("axeBond()"));
    bytes4 internal constant PROBE_FEE_READER = bytes4(keccak256("probeFee()"));
    bytes4 internal constant PENALTY_READER = bytes4(keccak256("penaltyRate()"));
    bytes4 internal constant VALUE_READER = bytes4(keccak256("value()"));
    bytes4 internal constant NO_READER = bytes4(keccak256("notAGetter()"));

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        orders = new OrderBook(DELAY, WINDOW, COMMIT_BOND, CANCEL_FEE, params, ROUND, REST);
        axes = new AxeBoard(
            ISealedOrderBook(address(orders)),
            IRespondentRegistry(address(0)),
            params,
            PROBE_FEE,
            AXE_BOND,
            ANSWER,
            OSR,
            MAX_OUT
        );
        vault = new RepoVault(new MockHolds(), address(0xE49), params, PENALTY_RATE, 5 days);
        book_ = new Rulebook(regime);
        _publishEdition(DOCUMENT, deployedSchedule());
    }

    // ------------------------------------------------------- the schedule

    /// @notice Section 8 of the document, as code. Keys ascend.
    function deployedSchedule() internal view returns (Rulebook.Charge[] memory s) {
        s = new Rulebook.Charge[](8);
        uint256 i = 0;
        s[i++] =
            _c("axe.post.bond", address(axes), AXE_BOND_READER, AXE_BOND, P_PART, P_NONE, true);
        s[i++] = _c(
            "axe.probe.fee", address(axes), PROBE_FEE_READER, PROBE_FEE, P_PART, P_CPTY, false
        );
        s[i++] = _c(
            "axe.probe.slash", address(axes), AXE_BOND_READER, AXE_BOND, P_PART, P_CPTY, false
        );
        s[i++] = _c(
            "book.commit.bond",
            address(orders),
            COMMIT_BOND_READER,
            COMMIT_BOND,
            P_PART,
            P_NONE,
            true
        );
        s[i++] = _c(
            "book.commit.cancel",
            address(orders),
            CANCEL_FEE_READER,
            CANCEL_FEE,
            P_PART,
            P_NONE,
            false
        );
        s[i++] = _c(
            "book.commit.forfeit",
            address(orders),
            COMMIT_BOND_READER,
            COMMIT_BOND,
            P_PART,
            P_CPTY,
            false
        );
        s[i++] = _c(
            "repo.fail.penalty",
            address(vault),
            PENALTY_READER,
            PENALTY_RATE,
            P_PART,
            P_CPTY,
            false
        );
        s[i++] = _c("venue.take", address(0), bytes4(0), 0, P_PART, P_OPER, false);
        _requireAscending(s);
    }

    Rulebook.Party internal constant P_NONE = Rulebook.Party.NOBODY;
    Rulebook.Party internal constant P_PART = Rulebook.Party.PARTICIPANT;
    Rulebook.Party internal constant P_CPTY = Rulebook.Party.COUNTERPARTY;
    Rulebook.Party internal constant P_OPER = Rulebook.Party.OPERATOR;

    function _c(
        bytes32 key,
        address source,
        bytes4 reader,
        uint256 amount,
        Rulebook.Party payer,
        Rulebook.Party payee,
        bool refundable
    ) internal pure returns (Rulebook.Charge memory) {
        return Rulebook.Charge({
            key: key,
            source: source,
            reader: reader,
            amount: amount,
            payer: payer,
            payee: payee,
            refundable: refundable
        });
    }

    /// @dev Keys are ASCII names, left aligned, so ascending order is
    ///      alphabetical and the schedule reads in the order section 8 prints
    ///      it. Checked here rather than letting a later insertion fail as
    ///      `KeysNotAscending` in twenty tests at once.
    function _requireAscending(Rulebook.Charge[] memory s) internal pure {
        for (uint256 i = 1; i < s.length; ++i) {
            require(s[i].key > s[i - 1].key, "fixture: schedule out of order");
        }
    }

    function _publishEdition(bytes32 doc, Rulebook.Charge[] memory s) internal {
        bytes32 e = book_.editionOf(doc, s);
        vm.prank(OPERATOR);
        book_.propose(e, "fixture");
        clock.tick();
        vm.prank(ANYONE);
        book_.adopt(doc, s);
    }

    function _at(Rulebook.Charge[] memory s, bytes32 key) internal pure returns (uint256) {
        for (uint256 i = 0; i < s.length; ++i) {
            if (s[i].key == key) return i;
        }
        revert("key not in schedule");
    }

    /// @dev Commit to `s` and arrive at its epoch, stopping short of adoption.
    ///      Split from `_publishEdition` so a test can arm `expectRevert` on
    ///      `adopt` alone: `editionOf` is an external call and would otherwise
    ///      consume it.
    function _propose(bytes32 doc, Rulebook.Charge[] memory s) internal {
        bytes32 e = book_.editionOf(doc, s);
        vm.prank(OPERATOR);
        book_.propose(e, "t");
        clock.tick();
    }

    function _tryPublish(bytes32 doc, Rulebook.Charge[] memory s) internal {
        _propose(doc, s);
        book_.adopt(doc, s);
    }

    // ------------------------------------------------ the document on disk

    /// @notice The published hash is the hash of the file in the repository.
    /// @dev The one check that keeps the page and the chain from drifting. A
    ///      rulebook whose hash names a document nobody has is not published.
    function test_theDocumentOnDiskIsTheDocumentPublished() public view {
        bytes32 onDisk = keccak256(bytes(vm.readFile("docs/RULEBOOK.md")));
        assertEq(onDisk, book_.document(), "docs/RULEBOOK.md changed without republishing");
        assertEq(onDisk, DOCUMENT);
    }

    // -------------------------------------------------------- publication

    function test_theEditionLandsAtTheNextEpochAndNotBefore() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        s[_at(s, "venue.take")].refundable = false;
        bytes32 doc = keccak256("second edition");
        bytes32 e = book_.editionOf(doc, s);

        vm.prank(OPERATOR);
        book_.propose(e, "r");

        uint64 now_ = clock.currentEpoch();
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.NotYetEffective.selector, now_ + 1, now_)
        );
        book_.adopt(doc, s);

        clock.tick();
        book_.adopt(doc, s);
        assertEq(book_.document(), doc);
    }

    function test_onlyTheOperatorProposes() public {
        vm.prank(ANYONE);
        vm.expectRevert(Rulebook.NotOperator.selector);
        book_.propose(keccak256("x"), "r");
    }

    /// @notice Anyone may open the commitment, and only someone holding it can.
    /// @notice CSDR Article 7(2): the penalty is not a revenue source.
    /// @dev The one clause of the regulation this page can check rather than
    ///      assert. Article 7 says the mechanism "shall not operate as a revenue
    ///      source", which is a constraint on **who is paid**, and the tariff
    ///      expresses exactly that: the line names the counterparty, so the
    ///      operator's net take cannot contain it.
    ///
    ///      The second half is what makes the first load-bearing. Move the payee
    ///      to the operator and the same schedule reports a take, so the
    ///      assertion is reading the property and not a constant.
    function test_theFailPenaltyIsNotVenueRevenue() public {
        (bool found, Rulebook.Charge memory c) = book_.chargeOf("repo.fail.penalty");
        assertTrue(found, "the penalty is not in the published tariff");
        assertEq(uint8(c.payer), uint8(P_PART));
        assertEq(uint8(c.payee), uint8(P_CPTY), "the venue is being paid the penalty");
        assertEq(book_.netOperatorTake(), 0, "the venue took something");

        Rulebook.Charge[] memory s = deployedSchedule();
        s[_at(s, "repo.fail.penalty")].payee = P_OPER;
        _publishEdition(DOCUMENT, s);
        assertEq(
            book_.netOperatorTake(),
            int256(PENALTY_RATE),
            "redirecting the payee did not change the answer"
        );
    }

    function test_adoptionIsPermissionlessAndNeedsTheEdition() public {
        assertEq(
            book_.chargeCount(),
            deployedSchedule().length,
            "setUp adopted from a non-operator address"
        );

        vm.expectRevert(Rulebook.NothingPending.selector);
        book_.adopt(DOCUMENT, deployedSchedule());
    }

    function test_adoptRefusesAScheduleThatIsNotTheCommitment() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        bytes32 e = book_.editionOf(DOCUMENT, s);
        vm.prank(OPERATOR);
        book_.propose(e, "r");
        clock.tick();

        s[_at(s, "venue.take")].payee = P_CPTY;
        bytes32 got = book_.editionOf(DOCUMENT, s);
        vm.expectRevert(abi.encodeWithSelector(Rulebook.EditionMismatch.selector, got, e));
        book_.adopt(DOCUMENT, s);
    }

    /// @notice The tariff cannot move without the document, in both directions.
    function test_theTariffAndTheDocumentAreOneCommitment() public view {
        Rulebook.Charge[] memory s = deployedSchedule();
        bytes32 base = book_.editionOf(DOCUMENT, s);

        assertTrue(base != book_.editionOf(keccak256("other doc"), s), "document is not bound");

        s[_at(s, "book.commit.cancel")].amount = CANCEL_FEE + 1;
        assertTrue(base != book_.editionOf(DOCUMENT, s), "amount is not bound");
    }

    function test_theSupersededEditionStaysCheckableForTheGrace() public {
        bytes32 first = book_.edition();

        Rulebook.Charge[] memory s = deployedSchedule();
        _tryPublish(keccak256("second edition"), s);

        assertTrue(book_.accepts(book_.edition()), "current edition refused");
        assertTrue(book_.accepts(first), "superseded edition refused inside the grace");

        vm.warp(book_.windowClosesAt() + 1);
        assertFalse(book_.accepts(first), "superseded edition accepted after the grace");
        assertFalse(book_.accepts(bytes32(0)), "the unpublished edition was accepted");
    }

    /// @notice A proposal that has gone stale cannot land.
    /// @dev There is no expiry on a pending edition and none is needed: the
    ///      schedule still has to agree with the code at the moment it is
    ///      opened, so an edition whose source moved while it sat pending is
    ///      refused rather than adopted against a number that has changed.
    function test_aProposalCannotLandAfterItsSourceHasMoved() public {
        MovableSource src = new MovableSource(4 wei);
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = address(src);
        s[i].reader = VALUE_READER;
        s[i].amount = 4 wei;
        s[i].payee = P_CPTY;
        _propose(DOCUMENT, s);

        src.set(5 wei);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.ChargeDoesNotReconcile.selector, s[i].key, 4, 5)
        );
        book_.adopt(DOCUMENT, s);
    }

    /// @notice The operator withdraws a pending edition by proposing zero.
    function test_theZeroEditionWithdrawsAPendingOne() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        bytes32 doc = keccak256("withdrawn");
        _propose(doc, s);

        vm.prank(OPERATOR);
        book_.propose(bytes32(0), "withdraw");

        vm.expectRevert(Rulebook.NothingPending.selector);
        book_.adopt(doc, s);
        assertEq(book_.document(), DOCUMENT, "the withdrawn edition landed anyway");
    }

    function test_theZeroDocumentIsRefused() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        bytes32 e = book_.editionOf(bytes32(0), s);
        vm.prank(OPERATOR);
        book_.propose(e, "r");
        clock.tick();
        vm.expectRevert(Rulebook.NoDocument.selector);
        book_.adopt(bytes32(0), s);
    }

    // ------------------------------------------------ schedule validation

    function test_aChargeWithNoPayerIsRefused() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].payer = P_NONE;
        s[i].payee = P_CPTY;
        _propose(DOCUMENT, s);
        vm.expectRevert(abi.encodeWithSelector(Rulebook.ChargeHasNoPayer.selector, s[i].key));
        book_.adopt(DOCUMENT, s);
    }

    function test_aCircularChargeIsRefused() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].payee = P_PART;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.ChargeIsCircular.selector, s[i].key, P_PART)
        );
        book_.adopt(DOCUMENT, s);
    }

    /// @notice A refundable charge comes back, so it cannot also go somewhere.
    function test_aRefundableChargeMayNotNameAPayee() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "book.commit.bond");
        s[i].payee = P_CPTY;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.RefundableChargeHasPayee.selector, s[i].key, P_CPTY)
        );
        book_.adopt(DOCUMENT, s);
    }

    /// @notice The venue may publish a zero it does not charge. It may not
    ///         publish a number with no contract behind it.
    function test_anUnsourcedChargeMustBeZero() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].amount = 1 wei;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.UnsourcedCharge.selector, s[i].key, 1 wei)
        );
        book_.adopt(DOCUMENT, s);
    }

    function test_aSourceWithNoCodeIsRefused() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = ANYONE;
        s[i].reader = COMMIT_BOND_READER;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.SourceHasNoCode.selector, s[i].key, ANYONE)
        );
        book_.adopt(DOCUMENT, s);
    }

    function test_aSourcedChargeNeedsAReader() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = address(orders);
        _propose(DOCUMENT, s);
        vm.expectRevert(abi.encodeWithSelector(Rulebook.SourceHasNoReader.selector, s[i].key));
        book_.adopt(DOCUMENT, s);
    }

    /// @notice A false tariff cannot be published truthfully.
    function test_aScheduleThatDisagreesWithTheCodeCannotBeAdopted() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "book.commit.cancel");
        s[i].amount = CANCEL_FEE + 1;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(
                Rulebook.ChargeDoesNotReconcile.selector, s[i].key, CANCEL_FEE + 1, CANCEL_FEE
            )
        );
        book_.adopt(DOCUMENT, s);
    }

    /// @notice A full schedule of the largest publishable charge still sums.
    /// @dev The bound is on the *sum*, not on one line: without it an operator
    ///      could publish 32 lines whose total overflows `int256` and make the
    ///      public read of the venue's take revert.
    function test_anAmountAboveTheReportableRangeIsRefused() public {
        uint256 max = uint256(type(int256).max) / book_.MAX_CHARGES();
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = address(new MovableSource(max + 1));
        s[i].reader = VALUE_READER;
        s[i].amount = max + 1;
        _propose(DOCUMENT, s);
        vm.expectRevert(
            abi.encodeWithSelector(
                Rulebook.AmountNotRepresentable.selector, s[i].key, max + 1, max
            )
        );
        book_.adopt(DOCUMENT, s);

        // At the bound, a full schedule of them reports rather than reverting.
        Rulebook.Charge[] memory big = new Rulebook.Charge[](book_.MAX_CHARGES());
        address src = address(new MovableSource(max));
        for (uint256 j = 0; j < big.length; ++j) {
            big[j] = _c(bytes32(j + 1), src, VALUE_READER, max, P_PART, P_OPER, false);
        }
        _tryPublish(keccak256("a full schedule"), big);
        assertEq(book_.netOperatorTake(), int256(max * book_.MAX_CHARGES()));
    }

    function test_keysMustAscendAndADuplicateIsRefused() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        (s[0], s[1]) = (s[1], s[0]);
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.KeysNotAscending.selector, s[0].key, s[1].key)
        );
        book_.editionOf(DOCUMENT, s);

        s = deployedSchedule();
        s[1] = s[0];
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.KeysNotAscending.selector, s[0].key, s[1].key)
        );
        book_.editionOf(DOCUMENT, s);
    }

    /// @notice The bound on `reconcile`. An unbounded schedule is an operator's
    ///         way to make the public check uncallable while staying published.
    function test_theScheduleIsBounded() public {
        Rulebook.Charge[] memory none = new Rulebook.Charge[](0);
        vm.expectRevert(Rulebook.EmptySchedule.selector);
        book_.editionOf(DOCUMENT, none);

        uint256 n = book_.MAX_CHARGES() + 1;
        Rulebook.Charge[] memory many = new Rulebook.Charge[](n);
        for (uint256 i = 0; i < n; ++i) {
            many[i] = _c(bytes32(i + 1), address(0), bytes4(0), 0, P_PART, P_OPER, false);
        }
        vm.expectRevert(
            abi.encodeWithSelector(Rulebook.ScheduleTooLong.selector, n, book_.MAX_CHARGES())
        );
        book_.editionOf(DOCUMENT, many);
    }

    // --------------------------------------------------- reconciliation

    function test_theDeployedTariffReconciles() public view {
        (bool ok, bytes32 key,,) = book_.reconcile();
        assertTrue(ok, "the published tariff is not the tariff the code charges");
        assertEq(key, bytes32(0));
    }

    /// @notice A charge that moves after publication is visible to anyone.
    function test_aChangedChargeIsVisibleToAnyone() public {
        Rulebook.Charge[] memory s = deployedSchedule();
        MovableSource src = new MovableSource(7);
        uint256 i = _at(s, "venue.take");
        s[i].source = address(src);
        s[i].reader = VALUE_READER;
        s[i].amount = 7;
        s[i].payee = P_OPER;
        _tryPublish(DOCUMENT, s);

        (bool ok,,,) = book_.reconcile();
        assertTrue(ok);

        src.set(8);
        bytes32 key;
        uint256 published;
        uint256 live;
        vm.prank(ANYONE);
        (ok, key, published, live) = book_.reconcile();
        assertFalse(ok, "a moved charge reconciled");
        assertEq(key, s[i].key);
        assertEq(published, 7);
        assertEq(live, 8);
    }

    /// @notice An unreadable source diverges rather than reverting the check.
    ///         An unreadable tariff is an unpublished one.
    function test_aSourceThatCannotBeReadDiverges() public {
        _adoptWithSource(address(new MovableSource(1)), VALUE_READER, 1);
        (bool ok,,,) = book_.reconcile();
        assertTrue(ok);

        // Each of these replaces the source at the same slot, so the published
        // amount stays 1 and only the readability changes.
        _assertDivergesUnder(address(new RevertingSource()));
        _assertDivergesUnder(address(new ShortSource()));
        _assertDivergesUnder(address(new HungrySource()));
    }

    /// @notice A returndata bomb costs the check nothing. The buffer is one word.
    function test_aReturndataBombCannotStallTheCheck() public {
        _adoptThenEtch(address(new BombSource()).code);
        uint256 before = gasleft();
        (bool ok, bytes32 key,,) = book_.reconcile();
        uint256 used = before - gasleft();
        assertFalse(ok, "a bomb reconciled");
        assertEq(key, bytes32("venue.take"));
        assertLt(used, 200_000, "the bomb made the public check expensive");
    }

    /// @notice A source burning gas cannot exhaust the loop. `READ_GAS` caps it.
    function test_aHostileSourceCannotExhaustTheCheck() public {
        _adoptThenEtch(address(new HungrySource()).code);
        uint256 before = gasleft();
        (bool ok,,,) = book_.reconcile();
        uint256 used = before - gasleft();
        assertFalse(ok);
        assertLt(used, 10 * book_.READ_GAS(), "one line consumed more than its budget");
    }

    /// @notice The check cannot be used to move state. `staticcall`, not `call`.
    /// @dev The published source is a `MovableSource` holding 1 at slot 0, and
    ///      `WritingSource` increments its own slot 0. If the read were a `call`
    ///      the slot would land on 2.
    function test_reconcileCannotWrite() public {
        address at = _adoptThenEtch(address(new WritingSource()).code);
        (bool ok,,,) = book_.reconcile();
        assertFalse(ok, "a writing getter reconciled");
        assertEq(uint256(vm.load(at, bytes32(0))), 1, "reconcile moved a source's state");
    }

    /// @dev Publish a readable source, then replace the code behind it. A source
    ///      that was hostile at adoption could not be adopted at all, so this is
    ///      the only shape the hazard takes: a line that reconciled once and
    ///      stopped.
    function _adoptThenEtch(bytes memory code) internal returns (address at) {
        _adoptWithSource(address(new MovableSource(1)), VALUE_READER, 1);
        at = _sourceOf(bytes32("venue.take"));
        vm.etch(at, code);
    }

    /// @dev Publish the deployed schedule with `venue.take` re-pointed at a
    ///      source, so one line varies and the rest stay real.
    function _adoptWithSource(address source, bytes4 reader, uint256 amount) internal {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = source;
        s[i].reader = reader;
        s[i].amount = amount;
        s[i].payee = P_CPTY;
        _tryPublish(DOCUMENT, s);
    }

    /// @dev The published line stays `(amount = 1)`; only the code at the
    ///      address changes, which is what a source going bad looks like.
    function _assertDivergesUnder(address source) internal {
        bytes32 key = bytes32("venue.take");
        vm.etch(_sourceOf(key), source.code);
        (bool ok, bytes32 got,,) = book_.reconcile();
        assertFalse(ok, "an unreadable source reconciled");
        assertEq(got, key);
    }

    function _sourceOf(bytes32 key) internal view returns (address) {
        (bool found, Rulebook.Charge memory c) = book_.chargeOf(key);
        require(found, "key not published");
        return c.source;
    }

    // ---------------------------------------------------------- the zero

    /// @notice Section 9. The venue take is published, and it is zero.
    function test_theVenueTakeIsZero() public view {
        assertEq(book_.netOperatorTake(), int256(0));
        (bool found, Rulebook.Charge memory c) = book_.chargeOf(bytes32("venue.take"));
        assertTrue(found, "the venue take is not published at all");
        assertEq(c.amount, 0);
        assertEq(c.source, address(0), "a zero take with a mechanism behind it");
        assertTrue(c.payee == P_OPER);
    }

    /// @notice No other line pays the operator either.
    function test_noLinePaysTheOperator() public view {
        uint256 n = book_.chargeCount();
        for (uint256 i = 0; i < n; ++i) {
            Rulebook.Charge memory c = book_.chargeAt(i);
            if (c.key == bytes32("venue.take")) continue;
            assertTrue(c.payee != P_OPER, "an operator-paying line outside venue.take");
            assertTrue(c.payer != P_OPER, "a rebate outside venue.take");
        }
    }

    /// @notice A take is representable, and it must be sourced to be non-zero.
    ///         That is the precondition: a fee the code does not charge cannot
    ///         be published, and one it does charge cannot be hidden.
    function test_aTakeMustBeSourcedToBeNonZero() public {
        MovableSource src = new MovableSource(3 wei);
        _adoptWithSourceAndPayee(address(src), VALUE_READER, 3 wei, P_OPER);
        assertEq(book_.netOperatorTake(), int256(3));
    }

    /// @notice A rebate is a negative take, published like every other line.
    function test_aRebateShowsAsANegativeTake() public {
        MovableSource src = new MovableSource(5 wei);
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = address(src);
        s[i].reader = VALUE_READER;
        s[i].amount = 5 wei;
        s[i].payer = P_OPER;
        s[i].payee = P_PART;
        _tryPublish(DOCUMENT, s);
        assertEq(book_.netOperatorTake(), int256(-5));
    }

    function _adoptWithSourceAndPayee(
        address source,
        bytes4 reader,
        uint256 amount,
        Rulebook.Party payee
    ) internal {
        Rulebook.Charge[] memory s = deployedSchedule();
        uint256 i = _at(s, "venue.take");
        s[i].source = source;
        s[i].reader = reader;
        s[i].amount = amount;
        s[i].payee = payee;
        _tryPublish(DOCUMENT, s);
    }

    // ------------------------------------------------------ the index

    /// @notice A key dropped by a later edition stops resolving.
    /// @dev The stale-index hazard: `adopt` clears the map before the array, and
    ///      without that a dropped key keeps pointing into a shorter schedule.
    function test_aDroppedKeyStopsResolving() public {
        bytes32 dropped = bytes32("book.commit.forfeit");
        (bool found,) = book_.chargeOf(dropped);
        assertTrue(found);

        Rulebook.Charge[] memory full = deployedSchedule();
        Rulebook.Charge[] memory s = new Rulebook.Charge[](2);
        s[0] = full[_at(full, "book.commit.bond")];
        s[1] = full[_at(full, "venue.take")];
        _tryPublish(keccak256("shorter"), s);

        (found,) = book_.chargeOf(dropped);
        assertFalse(found, "a dropped key still resolves");
        assertEq(book_.chargeCount(), 2);
        (bool ok,,,) = book_.reconcile();
        assertTrue(ok);
    }

    // ------------------------------------------------------------- fuzz

    /// @notice Every field is bound by the edition hash.
    function testFuzz_theEditionCommitsToEveryField(uint8 which, uint256 amount, address src)
        public
        view
    {
        Rulebook.Charge[] memory s = deployedSchedule();
        bytes32 base = book_.editionOf(DOCUMENT, s);
        uint256 i = _at(s, "book.commit.cancel");

        if (which % 4 == 0) {
            vm.assume(amount != s[i].amount);
            s[i].amount = amount;
        } else if (which % 4 == 1) {
            vm.assume(src != s[i].source);
            s[i].source = src;
        } else if (which % 4 == 2) {
            s[i].refundable = !s[i].refundable;
        } else {
            vm.assume(bytes4(bytes32(amount)) != s[i].reader);
            s[i].reader = bytes4(bytes32(amount));
        }
        assertTrue(book_.editionOf(DOCUMENT, s) != base, "a field escaped the commitment");
    }

    /// @notice Every published key resolves to its own line, and nothing else does.
    function testFuzz_theIndexResolvesExactlyThePublishedKeys(bytes32 key) public view {
        uint256 n = book_.chargeCount();
        for (uint256 i = 0; i < n; ++i) {
            Rulebook.Charge memory c = book_.chargeAt(i);
            (bool found, Rulebook.Charge memory got) = book_.chargeOf(c.key);
            assertTrue(found);
            assertEq(got.key, c.key);
            assertEq(got.amount, c.amount);
            if (key == c.key) return;
        }
        (bool f,) = book_.chargeOf(key);
        assertFalse(f, "an unpublished key resolved");
    }

    /// @notice The take is the sum of the operator lines, computed independently.
    function testFuzz_theTakeIsTheSumOfTheOperatorLines(uint96 a, uint96 b, bool rebate)
        public
    {
        MovableSource s1 = new MovableSource(a);
        MovableSource s2 = new MovableSource(b);
        Rulebook.Charge[] memory s = deployedSchedule();

        uint256 i = _at(s, "venue.take");
        s[i].source = address(s1);
        s[i].reader = VALUE_READER;
        s[i].amount = a;
        s[i].payer = rebate ? P_OPER : P_PART;
        s[i].payee = rebate ? P_PART : P_OPER;

        uint256 j = _at(s, "axe.probe.fee");
        s[j].source = address(s2);
        s[j].reader = VALUE_READER;
        s[j].amount = b;
        s[j].payee = P_OPER;

        _tryPublish(DOCUMENT, s);

        int256 want = int256(uint256(b)) + (rebate ? -int256(uint256(a)) : int256(uint256(a)));
        assertEq(book_.netOperatorTake(), want);
    }
}
