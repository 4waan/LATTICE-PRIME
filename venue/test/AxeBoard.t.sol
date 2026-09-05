// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {AxeBoard} from "../src/market/AxeBoard.sol";
import {IRespondentRegistry} from "../src/interfaces/IRespondentRegistry.sol";
import {ISealedOrderBook} from "../src/interfaces/ISealedOrderBook.sol";
import {AxeGrid} from "../src/market/AxeGrid.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";

contract RespondentRegistryMock is IRespondentRegistry {
    mapping(address => uint8) public override respondentType;

    function set(address who, uint8 t) external {
        respondentType[who] = t;
    }
}

    contract FatRegistry {
        function respondentType(address) external pure returns (uint256, uint256) {
            return (4, 4);
        }
    }

    contract DeadRegistry {
        function respondentType(address) external pure {
            revert("no");
        }
    }

    /// @dev Openings live here; building them in the test contract overflows the stack.
    contract CachedAxe {
        uint8 internal constant CLASS = 3;
        uint256 internal constant SIZE_LO = 1_000;
        uint256 internal constant SIZE_HI = 999_999;
        uint256 internal constant RATE_LO = 50;
        uint256 internal constant RATE_HI = 124;
        bytes32 internal constant MASTER = keccak256("lender-secret");

        bytes32 public grid;
        uint16 public cellYes;
        uint16 public cellNo;
        bool public yesCovered;
        bytes32 public yesSalt;
        bytes32[] public yesProof;
        bool public noCovered;
        bytes32 public noSalt;
        bytes32[] public noProof;

        constructor() {
            AxeGrid.Rect memory r = AxeGrid.bandRect(CLASS, SIZE_LO, SIZE_HI, RATE_LO, RATE_HI);
            grid = AxeGrid.rootOf(r, MASTER);
            cellYes = AxeGrid.cellFor(CLASS, 50_000, 80);
            cellNo = AxeGrid.cellFor(CLASS, 50, 80);
            (yesCovered, yesSalt, yesProof) = AxeGrid.openingOf(r, MASTER, cellYes);
            (noCovered, noSalt, noProof) = AxeGrid.openingOf(r, MASTER, cellNo);
        }

        function yes() external view returns (bool, bytes32, bytes32[] memory) {
            return (yesCovered, yesSalt, yesProof);
        }

        function no() external view returns (bool, bytes32, bytes32[] memory) {
            return (noCovered, noSalt, noProof);
        }
    }

    contract AxeBoardTest is Test, PolicyFixture {
        OrderBook internal book;
        AxeBoard internal board;
        RespondentRegistryMock internal registry;
        CachedAxe internal cache;

        address internal constant LENDER = address(0x1E4D);
        address internal constant BORROWER = address(0xB0);
        address internal constant MALLORY = address(0x4A11);
        address internal constant MAKER = address(0xAA);

        uint64 internal constant DELAY = 5 minutes;
        uint64 internal constant WINDOW = 30 minutes;
        uint256 internal constant COMMIT_BOND = 0.1 ether;
        uint64 internal constant ROUND = 1 days;
        uint64 internal constant REST = 7;
        uint256 internal constant CANCEL_FEE =
            (COMMIT_BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

        uint256 internal constant PROBE_FEE = 0.01 ether;
        uint32 internal constant MAX_OUT = 4;
        uint256 internal constant AXE_BOND = 4 * (0.1 ether - 0.01 ether) + 1;
        uint64 internal constant ANSWER = 1 hours;
        uint64 internal constant OSR = 4 hours;

        uint8 internal constant CLASS = 3;
        bytes32 internal constant AXE_SALT = keccak256("axe-salt");
        bytes32 internal constant MASTER = keccak256("lender-secret");

        bytes32 internal grid;
        uint16 internal cellYes;
        uint16 internal cellNo;
        bool internal yesCovered;
        bytes32 internal yesSalt;
        bytes32[] internal yesProof;
        bool internal noCovered;
        bytes32 internal noSalt;
        bytes32[] internal noProof;
        bytes32[] internal NONE;

        uint16 internal constant ROW_SIZE = 3;
        uint16 internal constant ROW_PRICE = 4;
        uint16 internal constant ROW_PRED = 13;
        uint16 internal constant ROW_ACTIVITY = 15;
        uint16 internal constant ROW_PROV = 17;

        /// @dev `meteredAxePredicate` rather than `asDeployed`, and the difference is
        ///      a real one rather than a convenience. Row 13 is the match predicate
        ///      and the two contracts that disclose on it do not agree about its
        ///      domain: `MatchingEngine` encodes a round's outcome in four events, so
        ///      `PolicySets.domainBitsOf(13)` is 2 and the deployed budget is 1 bit,
        ///      while a probe here ranges over an `AxeGrid` rectangle, which is
        ///      `RECTANGLE_BITS` = 18. One row, one published budget, so a venue that
        ///      deployed this board would have to republish row 13 against the wider
        ///      domain. The board is not deployed and has no address, so `asDeployed`
        ///      is derived from the engine alone and this suite runs under the set an
        ///      `AxeBoard` deployment would need. `boardRectangle` is that set and
        ///      `test_row13BudgetUsesTheRectangularDomain` asserts the number.
        function setUp() public {
            vm.warp(1_000_000);
            _deployPolicy(boardRectangle());
            book = new OrderBook(DELAY, WINDOW, COMMIT_BOND, CANCEL_FEE, params, ROUND, REST);
            registry = new RespondentRegistryMock();
            board = new AxeBoard(
                ISealedOrderBook(address(book)),
                registry,
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                OSR,
                MAX_OUT
            );

            cache = new CachedAxe();
            grid = cache.grid();
            cellYes = cache.cellYes();
            cellNo = cache.cellNo();
            (yesCovered, yesSalt, yesProof) = cache.yes();
            (noCovered, noSalt, noProof) = cache.no();

            vm.deal(LENDER, 100 ether);
            vm.deal(BORROWER, 100 ether);
            vm.deal(MALLORY, 100 ether);
            vm.deal(MAKER, 100 ether);
        }

        function test_fixTag1172IsTheTagsOwnNumbering() public view {
            assertEq(board.fixTag1172(AxeBoard.Respondent.ALL), 1);
            assertEq(board.fixTag1172(AxeBoard.Respondent.SPECIFIED), 2);
            assertEq(board.fixTag1172(AxeBoard.Respondent.MARKET_MAKERS), 3);
            assertEq(board.fixTag1172(AxeBoard.Respondent.PRIMARY), 4);
        }

        function test_aPublicAxeEmitsTheLenderAndNotTheBox() public {
            bytes32 axeId = board.axeIdOf(LENDER, grid, AXE_SALT);
            vm.expectEmit(true, true, false, true, address(board));
            emit AxeBoard.AxePosted(axeId, LENDER, 1, uint64(block.timestamp + 7 days));
            bytes32 got = _post(false);
            assertEq(got, axeId);
            (address lender,,,,,,,,,,) = board.axes(axeId);
            assertEq(lender, LENDER);
        }

        function test_aPrivateQuoteWithholdsThePosting() public {
            vm.recordLogs();
            _post(true);
            assertFalse(_saw(vm.getRecordedLogs(), AxeBoard.AxePosted.selector), "no AxePosted");
        }

        function test_theDeployedBondIsTheDerivedMinimum() public view {
            assertEq(board.axeBond(), AXE_BOND);
            assertEq(board.minimumAxeBond(COMMIT_BOND, PROBE_FEE, MAX_OUT), AXE_BOND);
        }

        function test_aBondBelowTheFloorCannotBeDeployed() public {
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.AxeBondTooLow.selector, AXE_BOND - 1, AXE_BOND)
            );
            new AxeBoard(
                ISealedOrderBook(address(book)),
                registry,
                params,
                PROBE_FEE,
                AXE_BOND - 1,
                ANSWER,
                OSR,
                MAX_OUT
            );
        }

        function test_zeroOutstandingOrZeroWindowCannotBeDeployed() public {
            vm.expectRevert(AxeBoard.ZeroOutstandingCap.selector);
            new AxeBoard(
                ISealedOrderBook(address(book)),
                registry,
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                OSR,
                0
            );
            vm.expectRevert(AxeBoard.ZeroWindow.selector);
            new AxeBoard(
                ISealedOrderBook(address(book)),
                registry,
                params,
                PROBE_FEE,
                AXE_BOND,
                0,
                OSR,
                MAX_OUT
            );
            vm.expectRevert(AxeBoard.ZeroWindow.selector);
            new AxeBoard(
                ISealedOrderBook(address(book)),
                registry,
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                0,
                MAX_OUT
            );
        }

        function testFuzz_honestyDominatesSilence(uint128 commit_, uint128 fee, uint8 m)
            public
            view
        {
            m = uint8(bound(m, 1, 32));
            uint256 floor_ = board.minimumAxeBond(commit_, fee, m);
            if (fee >= commit_) {
                assertEq(floor_, 1, "any positive bond will do once the fee covers the commit");
                return;
            }
            assertEq(floor_, uint256(m) * (uint256(commit_) - uint256(fee)) + 1);
            for (uint256 k = 1; k <= m; ++k) {
                assertGt(
                    floor_ + k * uint256(fee),
                    k * uint256(commit_),
                    "honesty is strictly cheaper than silence"
                );
            }
            assertFalse(
                (floor_ - 1) + uint256(m) * uint256(fee) > uint256(m) * uint256(commit_),
                "one wei under, silence wins at k = M"
            );
        }

        function test_wrongBondIsRefused() public {
            vm.prank(LENDER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.WrongBond.selector, 1, AXE_BOND));
            board.postAxe{value: 1}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 1),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );
        }

        function test_anEmptyGridIsRefused() public {
            vm.prank(LENDER);
            vm.expectRevert(AxeBoard.EmptyGrid.selector);
            board.postAxe{value: AXE_BOND}(
                bytes32(0),
                AXE_SALT,
                uint64(block.timestamp + 1),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );
        }

        function test_anAlreadyExpiredAxeIsRefused() public {
            vm.prank(LENDER);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.AxeHasExpired.selector, uint64(block.timestamp))
            );
            board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );
        }

        function test_specifiedNeedsASetAndTheOthersRefuseOne() public {
            vm.startPrank(LENDER);
            vm.expectRevert(AxeBoard.NoRespondentSet.selector);
            board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 1),
                AxeBoard.Respondent.SPECIFIED,
                bytes32(0),
                false
            );
            vm.expectRevert(AxeBoard.RespondentSetUnused.selector);
            board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 1),
                AxeBoard.Respondent.ALL,
                bytes32(uint256(1)),
                false
            );
            vm.stopPrank();
        }

        function test_marketMakerRolesNeedARegistry() public {
            AxeBoard bare = new AxeBoard(
                ISealedOrderBook(address(book)),
                IRespondentRegistry(address(0)),
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                OSR,
                MAX_OUT
            );
            vm.prank(LENDER);
            vm.expectRevert(AxeBoard.RespondentRegistryNotAttached.selector);
            bare.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 1),
                AxeBoard.Respondent.MARKET_MAKERS,
                bytes32(0),
                false
            );
        }

        function test_postingTwiceIsRefused() public {
            _post(false);
            vm.prank(LENDER);
            vm.expectRevert();
            board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );
        }

        function test_theOsrsOneBitAndThenTheLenderFirmsUp() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellYes);

            vm.expectEmit(true, false, false, true, address(board));
            emit AxeBoard.Answered(probeId, true);
            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);

            (AxeBoard.Status st, bool covered) = board.indicationOf(probeId);
            assertEq(uint256(st), uint256(AxeBoard.Status.INDICATED));
            assertTrue(covered);
            assertEq(board.credit(LENDER), PROBE_FEE, "the fee reached the lender");

            bytes32 orderId = _commit(LENDER, bytes32("firm"));
            vm.prank(LENDER);
            board.discharge(probeId, orderId);
            (st, covered) = board.indicationOf(probeId);
            assertEq(uint256(st), uint256(AxeBoard.Status.DISCHARGED));
            assertTrue(covered, "discharged is still a yes");
            assertEq(_outstanding(axeId), 0);
        }

        function test_aNegativeAnswerPaysAndCloses() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellNo);
            vm.prank(LENDER);
            board.answer(probeId, noCovered, noSalt, noProof);
            (AxeBoard.Status st, bool covered) = board.indicationOf(probeId);
            assertEq(uint256(st), uint256(AxeBoard.Status.CLOSED));
            assertFalse(covered);
            assertEq(_outstanding(axeId), 0);
            assertEq(board.credit(LENDER), PROBE_FEE);
        }

        function test_aLenderCannotFlipTheBit() public {
            bytes32 probeId = _probe(BORROWER, _post(false), cellYes);
            vm.prank(LENDER);
            vm.expectRevert(AxeBoard.OpeningDoesNotMatch.selector);
            board.answer(probeId, false, yesSalt, yesProof);
        }

        function test_aLenderCannotAnswerWithAnotherCellsOpening() public {
            bytes32 probeId = _probe(BORROWER, _post(false), cellYes);
            vm.prank(LENDER);
            vm.expectRevert(AxeBoard.OpeningDoesNotMatch.selector);
            board.answer(probeId, noCovered, noSalt, noProof);
        }

        function test_onlyTheLenderCanAnswer() public {
            bytes32 probeId = _probe(BORROWER, _post(false), cellYes);
            vm.prank(MALLORY);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotLender.selector, LENDER));
            board.answer(probeId, yesCovered, yesSalt, yesProof);
        }

        function test_theSameBoxCannotBeProbedTwiceByTheSameBorrower() public {
            bytes32 axeId = _post(false);
            _probe(BORROWER, axeId, cellYes);
            vm.prank(BORROWER);
            vm.expectRevert();
            board.probe{value: PROBE_FEE}(axeId, cellYes, bytes32(0), NONE);
        }

        function test_outstandingIsCapped() public {
            bytes32 axeId = _post(false);
            address[4] memory who = [BORROWER, MALLORY, MAKER, address(0xD00)];
            vm.deal(who[3], 1 ether);
            for (uint256 i = 0; i < 4; ++i) {
                _probe(who[i], axeId, cellYes);
            }
            address extra = address(0xE0);
            vm.deal(extra, 1 ether);
            vm.prank(extra);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.TooManyOutstanding.selector, MAX_OUT)
            );
            board.probe{value: PROBE_FEE}(axeId, cellYes, bytes32(0), NONE);
        }

        function test_answerClosesWhereSlashOpens() public {
            bytes32 probeId = _probe(BORROWER, _post(false), cellYes);
            uint64 due = board.slashableAfter(probeId);
            assertEq(due, uint64(block.timestamp) + ANSWER);

            vm.warp(due);
            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);

            bytes32 probeId2 = _probe(MALLORY, board.axeIdOf(LENDER, grid, AXE_SALT), cellNo);
            due = board.slashableAfter(probeId2);
            vm.prank(MALLORY);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotYetSlashable.selector, due));
            board.slash(probeId2);

            vm.warp(due + 1);
            vm.prank(LENDER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.AnswerWindowClosed.selector, due));
            board.answer(probeId2, noCovered, noSalt, noProof);

            vm.prank(MALLORY);
            board.slash(probeId2);
            assertEq(uint256(_status(probeId2)), uint256(AxeBoard.Status.SLASHED));
        }

        function test_silenceOnAnOpenProbePaysTheProberOnce() public {
            bytes32 axeId = _post(false);
            bytes32 a = _probe(BORROWER, axeId, cellYes);
            bytes32 b = _probe(MALLORY, axeId, cellNo);
            vm.warp(block.timestamp + ANSWER + 1);

            vm.prank(address(this));
            board.slash(a);
            assertEq(
                board.credit(BORROWER), AXE_BOND + PROBE_FEE, "injured party, not the caller"
            );
            assertEq(_bondOf(axeId), 0);
            assertTrue(_slashed(axeId));

            board.slash(b);
            assertEq(board.credit(MALLORY), PROBE_FEE, "fee only");
            assertEq(board.credit(BORROWER), AXE_BOND + PROBE_FEE, "the first take stands");
        }

        function test_anIndicationThatIsNotFirmedUpIsSlashed() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellYes);
            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);
            vm.warp(block.timestamp + OSR + 1);
            board.slash(probeId);
            assertEq(board.credit(BORROWER), AXE_BOND, "the fee already went to the lender");
            assertEq(board.credit(LENDER), PROBE_FEE);
            assertTrue(_slashed(axeId));
        }

        function test_aClosedOrDischargedProbeCannotBeSlashed() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellNo);
            vm.prank(LENDER);
            board.answer(probeId, noCovered, noSalt, noProof);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.NotSlashable.selector, AxeBoard.Status.CLOSED)
            );
            board.slash(probeId);
        }

        function test_onlyTheLenderCanPullTheirAxe() public {
            bytes32 axeId = _post(false);
            vm.prank(MALLORY);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotLender.selector, LENDER));
            board.withdrawAxe(axeId);
        }

        function test_withdrawalStopsNewProbesAndKeepsOutstandingOnes() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellYes);
            vm.prank(LENDER);
            board.withdrawAxe(axeId);

            vm.prank(MALLORY);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.AxeWasWithdrawn.selector, axeId));
            board.probe{value: PROBE_FEE}(axeId, cellNo, bytes32(0), NONE);

            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);
            assertEq(uint256(_status(probeId)), uint256(AxeBoard.Status.INDICATED));
        }

        function test_reclaimNeedsTheAxeToBeOverAndToOweNothing() public {
            bytes32 axeId = _post(false);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AxeBoard.AxeStillGood.selector, uint64(block.timestamp + 7 days)
                )
            );
            board.reclaimAxe(axeId);

            bytes32 probeId = _probe(BORROWER, axeId, cellYes);
            vm.prank(LENDER);
            board.withdrawAxe(axeId);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.ProbesOutstanding.selector, uint32(1))
            );
            board.reclaimAxe(axeId);

            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.ProbesOutstanding.selector, uint32(1))
            );
            board.reclaimAxe(axeId);

            bytes32 orderId = _commit(LENDER, bytes32("firm"));
            vm.prank(LENDER);
            board.discharge(probeId, orderId);
            board.reclaimAxe(axeId);
            assertEq(board.credit(LENDER), AXE_BOND + PROBE_FEE);
        }

        function test_theCreditIsWithdrawable() public {
            bytes32 axeId = _post(false);
            vm.prank(LENDER);
            board.withdrawAxe(axeId);
            vm.warp(block.timestamp + 1);
            board.reclaimAxe(axeId);
            uint256 before = LENDER.balance;
            vm.prank(LENDER);
            board.withdraw();
            assertEq(LENDER.balance, before + AXE_BOND);
            assertEq(address(board).balance, 0);
        }

        function test_dischargeRequiresTheLendersOwnLaterUncancelledCommitment() public {
            bytes32 axeId = _post(false);
            bytes32 probeId = _probe(BORROWER, axeId, cellYes);

            vm.prank(LENDER);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AxeBoard.ProbeNotIndicated.selector, AxeBoard.Status.OPEN
                )
            );
            board.discharge(probeId, bytes32(0));

            bytes32 early = _commit(LENDER, bytes32("early"));
            vm.warp(block.timestamp + 1);
            vm.prank(LENDER);
            board.answer(probeId, yesCovered, yesSalt, yesProof);

            bytes32 theirs = _commit(BORROWER, bytes32("nope"));
            vm.prank(LENDER);
            vm.expectRevert(
                abi.encodeWithSelector(AxeBoard.OrderIsNotTheLenders.selector, BORROWER)
            );
            board.discharge(probeId, theirs);

            vm.prank(LENDER);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AxeBoard.OrderPredatesTheIndication.selector,
                    uint64(block.timestamp - 1),
                    uint64(block.timestamp)
                )
            );
            board.discharge(probeId, early);

            bytes32 late = _commit(LENDER, bytes32("late"));
            vm.prank(LENDER);
            book.cancel(late);
            vm.prank(LENDER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.OrderWasCancelled.selector, late));
            board.discharge(probeId, late);

            bytes32 good = _commit(LENDER, bytes32("good"));
            vm.prank(LENDER);
            board.discharge(probeId, good);
        }

        function test_oneSealedOrderMayDischargeSeveralIndications() public {
            bytes32 axeId = _post(false);
            bytes32 a = _probe(BORROWER, axeId, cellYes);
            bytes32 b = _probe(MALLORY, axeId, AxeGrid.cellFor(CLASS, 80_000, 90));
            (bool covB, bytes32 saltB, bytes32[] memory proofB) = AxeGrid.openingOf(
                AxeGrid.bandRect(CLASS, 1_000, 999_999, 50, 124),
                MASTER,
                AxeGrid.cellFor(CLASS, 80_000, 90)
            );
            vm.startPrank(LENDER);
            board.answer(a, yesCovered, yesSalt, yesProof);
            board.answer(b, covB, saltB, proofB);
            vm.stopPrank();
            bytes32 orderId = _commit(LENDER, bytes32("one-lot"));
            vm.startPrank(LENDER);
            board.discharge(a, orderId);
            board.discharge(b, orderId);
            vm.stopPrank();
            assertEq(_outstanding(axeId), 0);
        }

        function test_aSpecifiedSetAdmitsOnlyItsMembers() public {
            bytes32 saltB = keccak256("member-b");
            bytes32 saltM = keccak256("member-m");
            bytes32 leafB = keccak256(abi.encode(board.DOMAIN_MEMBER(), BORROWER, saltB));
            bytes32 leafM = keccak256(abi.encode(board.DOMAIN_MEMBER(), MALLORY, saltM));
            bytes32 root_ = _pair(leafB, leafM);

            vm.prank(LENDER);
            bytes32 axeId = board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.SPECIFIED,
                root_,
                false
            );

            bytes32[] memory proofB = new bytes32[](1);
            proofB[0] = leafM;
            vm.prank(BORROWER);
            board.probe{value: PROBE_FEE}(axeId, cellYes, saltB, proofB);

            bytes32[] memory proofM = new bytes32[](1);
            proofM[0] = leafB;
            vm.prank(MAKER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotARespondent.selector, MAKER));
            board.probe{value: PROBE_FEE}(axeId, cellYes, saltM, proofM);
        }

        function test_marketMakersAreARoleAndAFatRegistryDenies() public {
            registry.set(MAKER, 3);
            registry.set(BORROWER, 1);
            vm.prank(LENDER);
            bytes32 axeId = board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.MARKET_MAKERS,
                bytes32(0),
                false
            );
            _probe(MAKER, axeId, cellYes);
            vm.prank(BORROWER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotARespondent.selector, BORROWER));
            board.probe{value: PROBE_FEE}(axeId, cellYes, bytes32(0), NONE);

            AxeBoard fat = new AxeBoard(
                ISealedOrderBook(address(book)),
                IRespondentRegistry(address(new FatRegistry())),
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                OSR,
                MAX_OUT
            );
            vm.prank(LENDER);
            bytes32 fatId = fat.postAxe{value: AXE_BOND}(
                grid,
                keccak256("fat"),
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.PRIMARY,
                bytes32(0),
                false
            );
            vm.prank(MAKER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotARespondent.selector, MAKER));
            fat.probe{value: PROBE_FEE}(fatId, cellYes, bytes32(0), NONE);

            AxeBoard dead = new AxeBoard(
                ISealedOrderBook(address(book)),
                IRespondentRegistry(address(new DeadRegistry())),
                params,
                PROBE_FEE,
                AXE_BOND,
                ANSWER,
                OSR,
                MAX_OUT
            );
            vm.prank(LENDER);
            bytes32 deadId = dead.postAxe{value: AXE_BOND}(
                grid,
                keccak256("dead"),
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.MARKET_MAKERS,
                bytes32(0),
                false
            );
            vm.prank(MAKER);
            vm.expectRevert(abi.encodeWithSelector(AxeBoard.NotARespondent.selector, MAKER));
            dead.probe{value: PROBE_FEE}(deadId, cellYes, bytes32(0), NONE);
        }

        function test_theFourthProbeOfAnEpochIsRefused() public {
            _publish(meteredAxePredicate());
            assertEq(board.breakingSize(ROW_PRED, L.G_PRED), 4);
            assertEq(board.indicationsLeft(), 3);

            bytes32 axeId = _post(false);
            _probe(BORROWER, axeId, cellYes);
            _probe(MALLORY, axeId, cellNo);
            _probe(MAKER, axeId, AxeGrid.cellFor(CLASS, 5_000, 60));
            assertEq(board.indicationsLeft(), 0);

            address extra = address(0xE0);
            vm.deal(extra, 1 ether);
            vm.prank(extra);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AxeBoard.PredicateBudgetExhausted.selector, ROW_PRED, uint32(3), uint32(3)
                )
            );
            board.probe{value: PROBE_FEE}(axeId, cellYes, bytes32(0), NONE);

            clock.tick();
            assertEq(board.indicationsLeft(), 3);
            _probe(extra, axeId, cellYes);
            assertEq(board.indicationsLeft(), 2);
        }

        function test_theBandedSetMetersTheProbeAndRefusesTheReveal() public {
            _publish(bandedDiscovery());
            assertTrue(board.wouldDisclose(ROW_SIZE, L.G_BUCKET, L.T_IMM), "a probe may speak");
            assertFalse(book.wouldDisclose(ROW_SIZE, L.G_EXACT, L.T_IMM), "a reveal may not");

            bytes32 axeId = _post(false);
            vm.recordLogs();
            _probe(BORROWER, axeId, cellYes);
            assertTrue(_saw(vm.getRecordedLogs(), AxeBoard.Probed.selector), "the probe landed");

            _commit(LENDER, bytes32("reveal-me"));
            vm.warp(block.timestamp + DELAY + 1);
            vm.prank(LENDER);
            vm.expectRevert();
            book.reveal(OrderBook.Side.BUY, 101, 5_000, bytes32("reveal-me"), 0);

            _publish(meteredAxeBands());
            assertEq(
                board.breakingSize(ROW_SIZE, L.G_BUCKET), 3, "two announce, the third is silent"
            );
            assertEq(board.breakingSize(ROW_PRICE, L.G_BUCKET), 3);
            assertFalse(
                book.wouldDisclose(ROW_SIZE, L.G_EXACT, L.T_IMM),
                "the exact reveal is still refused under the metered set"
            );
        }

        function test_theThirdBandedProbeIsSilentAndStillStands() public {
            _publish(meteredAxeBands());
            bytes32 axeId = _post(false);
            address[3] memory who = [BORROWER, MALLORY, MAKER];
            uint16[3] memory cells = [cellYes, cellNo, AxeGrid.cellFor(CLASS, 5_000, 60)];
            for (uint256 i = 0; i < 3; ++i) {
                vm.recordLogs();
                _probe(who[i], axeId, cells[i]);
                bool announced = _saw(vm.getRecordedLogs(), AxeBoard.Probed.selector);
                if (i < 2) assertTrue(announced, "inside the budget");
                else assertFalse(announced, "past it the venue goes quiet");
                assertTrue(
                    _status(board.probeIdOf(axeId, who[i], cells[i])) == AxeBoard.Status.OPEN
                );
            }
        }

        function test_theDeployedExactRowsRefuseABudget() public {
            ParameterRoot.Param[] memory next =
                _with(asDeployed(), bytes32(uint256(36 + 3)), _packBudget(16, 2, 4, 8));

            bytes32 r = params.rootOf(next);
            vm.prank(OPERATOR);
            params.propose(r, "refuse");
            clock.tick();
            vm.expectRevert(
                abi.encodeWithSelector(
                    ParameterRoot.BudgetCannotBindRow.selector, uint16(3), params.ceilingFor(3)
                )
            );
            params.adopt(next);
        }

        function test_row13BudgetUsesTheRectangularDomain() public {
            _publish(meteredAxePredicate());
            B.Row memory r = params.budgetFor(ROW_PRED);
            assertEq(
                r.domainBits, AxeGrid.RECTANGLE_BITS, "the budget is set against the domain"
            );
            assertEq(B.bits(r, L.G_PRED), 1);
            assertEq(B.breakingSize(r, L.G_PRED), r.budgetBits + 1);
        }

        function test_anUnpublishedPredicateRowMeansNoBoard() public {
            _publish(_withoutRow(13));
            vm.prank(LENDER);
            bytes32 axeId = board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );
            vm.prank(BORROWER);
            vm.expectRevert();
            board.probe{value: PROBE_FEE}(axeId, cellYes, bytes32(0), NONE);
        }

        function _post(bool priv) internal returns (bytes32 axeId) {
            vm.prank(LENDER);
            axeId = board.postAxe{value: AXE_BOND}(
                grid,
                AXE_SALT,
                uint64(block.timestamp + 7 days),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                priv
            );
        }

        function _probe(address who, bytes32 axeId, uint16 cell) internal returns (bytes32) {
            vm.prank(who);
            return board.probe{value: PROBE_FEE}(axeId, cell, bytes32(0), NONE);
        }

        function _commit(address who, bytes32 salt) internal returns (bytes32 id) {
            id = book.commitmentOf(who, OrderBook.Side.BUY, 101, 5_000, salt);
            vm.prank(who);
            book.commit{value: COMMIT_BOND}(id);
        }

        function _outstanding(bytes32 axeId) internal view returns (uint32 o) {
            (,,,,,,,,, o,) = board.axes(axeId);
        }

        function _slashed(bytes32 axeId) internal view returns (bool s) {
            (,,,,,,,, s,,) = board.axes(axeId);
        }

        function _bondOf(bytes32 axeId) internal view returns (uint256 b) {
            (,,,,,,,,,, b) = board.axes(axeId);
        }

        function _status(bytes32 probeId) internal view returns (AxeBoard.Status st) {
            (st,) = board.indicationOf(probeId);
        }

        function _pair(bytes32 a, bytes32 b) internal view returns (bytes32) {
            return a <= b
                ? keccak256(abi.encode(board.DOMAIN_PAIR(), a, b))
                : keccak256(abi.encode(board.DOMAIN_PAIR(), b, a));
        }

        function _saw(Vm.Log[] memory logs, bytes32 sel) internal pure returns (bool) {
            for (uint256 i = 0; i < logs.length; ++i) {
                if (logs[i].topics[0] == sel) return true;
            }
            return false;
        }

        function _withoutRow(uint16 row)
            internal
            pure
            returns (ParameterRoot.Param[] memory out)
        {
            return _withoutRowAndItsBudget(row);
        }

        receive() external payable {}
    }

    contract AxeHandler is Test {
        AxeBoard public immutable board;
        OrderBook public immutable book;
        address public immutable lender;
        bytes32 public immutable axeId;
        bytes32[] public probeIds;
        mapping(bytes32 => uint16) public cellOf;
        mapping(bytes32 => bool) public known;

        bool public yesCovered;
        bytes32 public yesSalt;
        bytes32[] public yesProof;
        bool public noCovered;
        bytes32 public noSalt;
        bytes32[] public noProof;
        uint16 public cellYes;
        uint16 public cellNo;

        address[3] public actors;
        bytes32[] internal NONE;

        uint256 public probes;
        uint256 public answers;
        uint256 public slashes;
        uint256 public discharges;
        uint256 public withdrawals;
        uint256 public pulls;
        uint256 public reclaims;
        uint256 public ghost;

        constructor(
            AxeBoard board_,
            OrderBook book_,
            address lender_,
            bytes32 axeId_,
            CachedAxe cache
        ) {
            require(axeId_ != bytes32(0), "axe id");
            board = board_;
            book = book_;
            lender = lender_;
            axeId = axeId_;
            cellYes = cache.cellYes();
            cellNo = cache.cellNo();
            (yesCovered, yesSalt, yesProof) = cache.yes();
            (noCovered, noSalt, noProof) = cache.no();
            actors = [address(0xB1), address(0xB2), address(0xB3)];
            for (uint256 i = 0; i < 3; ++i) {
                vm.deal(actors[i], 100 ether);
            }
            vm.deal(lender, 100 ether);
            vm.deal(address(this), 1_000 ether);
            ghost = address(board_).balance;
        }

        function actorCount() external view returns (uint256) {
            return actors.length;
        }

        function probeCount() external view returns (uint256) {
            return probeIds.length;
        }

        function doProbe(uint256 seed) external {
            address who = actors[seed % 3];
            uint16 cell = seed % 2 == 0 ? cellYes : cellNo;
            vm.prank(who);
            try board.probe{value: board.probeFee()}(axeId, cell, bytes32(0), NONE) returns (
                bytes32 id
            ) {
                if (!known[id]) {
                    known[id] = true;
                    probeIds.push(id);
                    cellOf[id] = cell;
                }
                ghost += board.probeFee();
                probes++;
            } catch {}
        }

        function doAnswer(uint256 seed) external {
            if (probeIds.length == 0) return;
            bytes32 id = probeIds[seed % probeIds.length];
            uint16 cell = cellOf[id];
            bool covered = cell == cellYes ? yesCovered : noCovered;
            bytes32 salt = cell == cellYes ? yesSalt : noSalt;
            bytes32[] memory proof = cell == cellYes ? yesProof : noProof;
            vm.prank(lender);
            try board.answer(id, covered, salt, proof) {
                answers++;
            } catch {}
        }

        function doLie(uint256 seed) external {
            if (probeIds.length == 0) return;
            bytes32 id = probeIds[seed % probeIds.length];
            vm.prank(lender);
            try board.answer(id, true, yesSalt, yesProof) {} catch {}
        }

        function doSlash(uint256 seed) external {
            if (probeIds.length == 0) return;
            bytes32 id = probeIds[seed % probeIds.length];
            try board.slash(id) {
                slashes++;
            } catch {}
        }

        function doCommitAndDischarge(uint256 seed) external {
            if (probeIds.length == 0) return;
            bytes32 id = probeIds[seed % probeIds.length];
            bytes32 salt = keccak256(abi.encode("inv", seed, id));
            bytes32 orderId = book.commitmentOf(lender, OrderBook.Side.BUY, 101, 5_000, salt);
            vm.prank(lender);
            try book.commit{value: book.commitBond()}(orderId) {} catch {}
            vm.prank(lender);
            try board.discharge(id, orderId) {
                discharges++;
            } catch {}
        }

        function doWithdrawAxe() external {
            vm.prank(lender);
            try board.withdrawAxe(axeId) {
                pulls++;
            } catch {}
        }

        function doReclaim() external {
            try board.reclaimAxe(axeId) {
                reclaims++;
            } catch {}
        }

        function doWithdrawCredit(uint256 seed) external {
            address who = seed % 2 == 0 ? lender : actors[seed % 3];
            uint256 before = board.credit(who);
            vm.prank(who);
            try board.withdraw() {
                if (before != 0) {
                    ghost -= before;
                    withdrawals++;
                }
            } catch {}
        }

        function doWarpFine(uint256 dt) external {
            vm.warp(block.timestamp + bound(dt, 1, 1 hours));
        }

        function doWarpCoarse(uint256 dt) external {
            vm.warp(block.timestamp + bound(dt, 1 hours, 8 days));
        }

        function accounted() external view returns (uint256) {
            return bondLeft() + _feesHeld() + _creditHeld();
        }

        function outstanding() external view returns (uint32 o) {
            (,,,,,,,,, o,) = board.axes(axeId);
        }

        function slashed() external view returns (bool s) {
            (,,,,,,,, s,,) = board.axes(axeId);
        }

        function bondLeft() public view returns (uint256 b) {
            (,,,,,,,,,, b) = board.axes(axeId);
        }

        function _feesHeld() private view returns (uint256 fees) {
            uint256 n = probeIds.length;
            for (uint256 i = 0; i < n; ++i) {
                fees += _feeOf(probeIds[i]);
            }
        }

        function _feeOf(bytes32 id) private view returns (uint256 fee) {
            (,,,,,, fee) = board.probes(id);
        }

        function _creditHeld() private view returns (uint256 c) {
            c = board.credit(lender);
            c += board.credit(address(this));
            c += board.credit(actors[0]);
            c += board.credit(actors[1]);
            c += board.credit(actors[2]);
        }
    }

    contract AxeBoardInvariantTest is Test, PolicyFixture {
        OrderBook internal book;
        AxeBoard internal board;
        AxeHandler internal handler;

        uint64 internal constant DELAY = 5 minutes;
        uint64 internal constant WINDOW = 30 minutes;
        uint256 internal constant COMMIT_BOND = 0.1 ether;
        uint256 internal constant CANCEL_FEE =
            (COMMIT_BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);
        uint256 internal constant PROBE_FEE = 0.01 ether;
        uint256 internal constant AXE_BOND = 4 * (0.1 ether - 0.01 ether) + 1;
        address internal constant LENDER = address(0x1E4D);

        function setUp() public {
            vm.warp(1_000_000);
            // The board's set, for the reason `AxeBoardTest.setUp` gives.
            _deployPolicy(boardRectangle());
            book = new OrderBook(DELAY, WINDOW, COMMIT_BOND, CANCEL_FEE, params, 1 days, 7);
            board = new AxeBoard(
                ISealedOrderBook(address(book)),
                IRespondentRegistry(address(0)),
                params,
                PROBE_FEE,
                AXE_BOND,
                1 hours,
                4 hours,
                4
            );

            CachedAxe cache = new CachedAxe();
            vm.deal(LENDER, 100 ether);
            vm.prank(LENDER);
            bytes32 axeId = board.postAxe{value: AXE_BOND}(
                cache.grid(),
                keccak256("axe-salt"),
                uint64(block.timestamp + 30 days),
                AxeBoard.Respondent.ALL,
                bytes32(0),
                false
            );

            handler = new AxeHandler(board, book, LENDER, axeId, cache);
            targetContract(address(handler));
        }

        function test_accountedMatchesOnAQuietBoard() public view {
            assertEq(handler.bondLeft(), AXE_BOND, "the posted bond is still on the axe");
            assertEq(address(board).balance, AXE_BOND);
            assertEq(address(board).balance, handler.ghost());
        }

        function invariant_etherIsConserved() public view {
            assertEq(
                address(board).balance,
                handler.ghost(),
                "balance == undeclared credits and bonds"
            );
        }

        function invariant_outstandingCountsOpenAndIndicated() public view {
            uint32 live;
            uint256 n = handler.probeCount();
            for (uint256 i = 0; i < n; ++i) {
                (,,,,, AxeBoard.Status st,) = board.probes(handler.probeIds(i));
                if (st == AxeBoard.Status.OPEN || st == AxeBoard.Status.INDICATED) live++;
            }
            assertEq(handler.outstanding(), live);
        }

        function invariant_aSlashedAxeHoldsNoBond() public view {
            if (handler.slashed()) assertEq(handler.bondLeft(), 0);
        }

        function afterInvariant() public view {
            assertGt(
                handler.probes() + handler.answers() + handler.slashes() + handler.discharges()
                    + handler.withdrawals() + handler.pulls() + handler.reclaims(),
                0,
                "the handler never landed an action"
            );
        }
    }
