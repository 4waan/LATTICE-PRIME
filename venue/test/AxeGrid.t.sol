// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AxeGrid} from "../src/market/AxeGrid.sol";
import {AxeBoard} from "../src/market/AxeBoard.sol";
import {ISealedOrderBook} from "../src/interfaces/ISealedOrderBook.sol";
import {IRespondentRegistry} from "../src/interfaces/IRespondentRegistry.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";

contract AxeGridTest is Test {
    string internal json;

    uint8 internal constant CLASS = 3;
    uint256 internal constant SIZE_LO = 1_000;
    uint256 internal constant SIZE_HI = 999_999;
    uint256 internal constant RATE_LO = 50;
    uint256 internal constant RATE_HI = 124;
    bytes32 internal constant MASTER = keccak256("lender-secret");

    AxeGrid.Rect internal rect;
    bytes32 internal root;
    uint16 internal cellYes;
    uint16 internal cellNo;
    uint16 internal cellOtherClass;

    function setUp() public {
        json = vm.readFile("test/fixtures/axe-grid.json");
        rect = AxeGrid.bandRect(CLASS, SIZE_LO, SIZE_HI, RATE_LO, RATE_HI);
        root = AxeGrid.rootOf(rect, MASTER);
        cellYes = AxeGrid.cellFor(CLASS, 50_000, 80);
        cellNo = AxeGrid.cellFor(CLASS, 50, 80);
        cellOtherClass = AxeGrid.cellFor(CLASS + 1, 50_000, 80);
    }

    function test_theReferenceVectorsReplay() public view {
        assertEq(
            AxeGrid.rectangleCount(),
            vm.parseJsonUint(json, ".rectangleCount"),
            "rectangleCount"
        );
        assertEq(
            AxeGrid.rectangleBits(), vm.parseJsonUint(json, ".rectangleBits"), "rectangleBits"
        );

        uint256 n = 11;
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".sizeBand[", vm.toString(i), "]");
            uint256 v = vm.parseJsonUint(json, string.concat(p, ".v"));
            uint256 b = vm.parseJsonUint(json, string.concat(p, ".b"));
            assertEq(uint256(AxeGrid.sizeBand(v)), b, string.concat(p, " size"));
        }

        n = 9;
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".rateBand[", vm.toString(i), "]");
            uint256 v = vm.parseJsonUint(json, string.concat(p, ".v"));
            uint256 b = vm.parseJsonUint(json, string.concat(p, ".b"));
            assertEq(uint256(AxeGrid.rateBand(v)), b, string.concat(p, " rate"));
        }
    }

    function test_theBondFloorReplays() public {
        AxeBoard board = _bareBoard();
        uint256 n = 5;
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".bond[", vm.toString(i), "]");
            uint256 commit_ = vm.parseJsonUint(json, string.concat(p, ".commit"));
            uint256 fee = vm.parseJsonUint(json, string.concat(p, ".fee"));
            uint256 m = vm.parseJsonUint(json, string.concat(p, ".m"));
            uint256 floor_ = vm.parseJsonUint(json, string.concat(p, ".floor"));
            assertEq(board.minimumAxeBond(commit_, fee, uint32(m)), floor_, p);
        }
    }

    function test_theSizeBandIsTheVenuesBucketFunction() public pure {
        uint256[9] memory vs = [uint256(0), 1, 9, 10, 99, 100, 10 ** 14, 10 ** 15 - 1, 10 ** 15];
        for (uint256 i = 0; i < vs.length; ++i) {
            assertEq(
                uint256(AxeGrid.sizeBand(vs[i])),
                _venueBucket(vs[i]),
                "below the cap they are the same function"
            );
        }
        assertEq(AxeGrid.sizeBand(10 ** 16), 15, "the cap holds");
        assertEq(_venueBucket(10 ** 16), 16, "the venue function does not cap");
        assertEq(AxeGrid.sizeBand(type(uint256).max), 15, "and the axis is total");
    }

    function test_intersectionIsTheBandInterval() public pure {
        uint256[16] memory sizes = [
            uint256(0),
            1,
            9,
            10,
            99,
            100,
            999,
            1_000,
            9_999,
            10_000,
            10 ** 14 - 1,
            10 ** 14,
            10 ** 15 - 1,
            10 ** 15,
            10 ** 16,
            type(uint256).max
        ];

        uint256 checks;
        for (uint256 i = 0; i < sizes.length; ++i) {
            for (uint256 j = 0; j < sizes.length; ++j) {
                uint256 lo = sizes[i];
                uint256 hi = sizes[j];
                if (lo > hi) continue;
                uint8 blo = AxeGrid.sizeBand(lo);
                uint8 bhi = AxeGrid.sizeBand(hi);
                for (uint8 b = 0; b < AxeGrid.SIZE_CARD; ++b) {
                    bool claimed = blo <= b && b <= bhi;
                    bool actual = AxeGrid.sizeBandLow(b) <= hi && AxeGrid.sizeBandHigh(b) >= lo;
                    assertEq(claimed, actual, "size band intersection");
                    checks++;
                }
            }
        }
        assertGt(checks, 1_000, "the grid was not empty");

        uint256[12] memory rates =
            [uint256(0), 24, 25, 49, 50, 74, 75, 374, 375, 376, 10_000, type(uint256).max];
        for (uint256 i = 0; i < rates.length; ++i) {
            for (uint256 j = 0; j < rates.length; ++j) {
                if (rates[i] > rates[j]) continue;
                uint8 blo = AxeGrid.rateBand(rates[i]);
                uint8 bhi = AxeGrid.rateBand(rates[j]);
                for (uint8 b = 0; b < AxeGrid.RATE_CARD; ++b) {
                    bool claimed = blo <= b && b <= bhi;
                    bool actual = AxeGrid.rateBandLow(b) <= rates[j]
                        && AxeGrid.rateBandHigh(b) >= rates[i];
                    assertEq(claimed, actual, "rate band intersection");
                }
            }
        }
    }

    function test_theDomainOfARectangularAxeIsEighteenBits() public pure {
        uint256 n;
        for (uint8 c = 0; c < AxeGrid.CLASS_CARD; ++c) {
            for (uint8 sLo = 0; sLo < AxeGrid.SIZE_CARD; ++sLo) {
                for (uint8 sHi = sLo; sHi < AxeGrid.SIZE_CARD; ++sHi) {
                    for (uint8 rLo = 0; rLo < AxeGrid.RATE_CARD; ++rLo) {
                        for (uint8 rHi = rLo; rHi < AxeGrid.RATE_CARD; ++rHi) {
                            n++;
                        }
                    }
                }
            }
        }
        assertEq(n, 147_968, "the enumeration");
        assertEq(AxeGrid.rectangleCount(), n, "the closed form");
        assertEq(AxeGrid.rectangleBits(), 18, "ceil(log2(n))");
        assertEq(AxeGrid.RECTANGLE_BITS, AxeGrid.rectangleBits(), "the constant is the claim");
        assertTrue((uint256(1) << 17) < n && n <= (uint256(1) << 18), "between two powers");
    }

    function test_theSizeAxisIsTotalAndTheBandsAreInhabited() public pure {
        assertEq(AxeGrid.sizeBand(0), 0);
        assertEq(AxeGrid.sizeBand(type(uint256).max), 15);
        for (uint8 b = 0; b < AxeGrid.SIZE_CARD; ++b) {
            uint256 lo = AxeGrid.sizeBandLow(b);
            uint256 hi = AxeGrid.sizeBandHigh(b);
            assertEq(AxeGrid.sizeBand(lo), b, "low end of the band");
            if (b != AxeGrid.SIZE_CARD - 1) {
                assertEq(AxeGrid.sizeBand(hi), b, "high end of the band");
                assertEq(
                    AxeGrid.sizeBand(hi + 1), b + 1, "the next band starts where this ends"
                );
            }
        }
    }

    function test_theRateAxisIsLinearAndTheTopBandIsOpen() public pure {
        for (uint8 b = 0; b < AxeGrid.RATE_CARD - 1; ++b) {
            assertEq(AxeGrid.rateBand(AxeGrid.rateBandLow(b)), b);
            assertEq(AxeGrid.rateBand(AxeGrid.rateBandHigh(b)), b);
            assertEq(AxeGrid.rateBandHigh(b) - AxeGrid.rateBandLow(b), 24);
        }
        assertEq(AxeGrid.rateBand(375), 15);
        assertEq(AxeGrid.rateBand(10_000), 15);
        assertEq(AxeGrid.rateBand(type(uint256).max), 15);
    }

    function testFuzz_sizeBandIsMonotone(uint256 a, uint256 b) public pure {
        if (a > b) (a, b) = (b, a);
        assertLe(AxeGrid.sizeBand(a), AxeGrid.sizeBand(b));
    }

    function testFuzz_rateBandIsMonotone(uint256 a, uint256 b) public pure {
        if (a > b) (a, b) = (b, a);
        assertLe(AxeGrid.rateBand(a), AxeGrid.rateBand(b));
    }

    function test_anEmptyRangeIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(AxeGrid.EmptyRange.selector, uint8(0), uint8(0)));
        this.callBandRect(CLASS, 100, 10, 50, 80);
        vm.expectRevert(abi.encodeWithSelector(AxeGrid.EmptyRange.selector, uint8(0), uint8(0)));
        this.callBandRect(CLASS, 10, 100, 80, 50);
    }

    function callBandRect(uint8 c, uint256 sLo, uint256 sHi, uint256 rLo, uint256 rHi)
        external
        pure
        returns (AxeGrid.Rect memory)
    {
        return AxeGrid.bandRect(c, sLo, sHi, rLo, rHi);
    }

    function test_theCellPackingIsDenseAndInvertible() public pure {
        uint256 seen;
        for (uint8 c = 0; c < AxeGrid.CLASS_CARD; ++c) {
            for (uint8 s = 0; s < AxeGrid.SIZE_CARD; ++s) {
                for (uint8 r = 0; r < AxeGrid.RATE_CARD; ++r) {
                    uint16 cell = AxeGrid.cellOf(c, s, r);
                    assertLt(cell, AxeGrid.CELL_CARD);
                    assertEq(AxeGrid.classOfCell(cell), c);
                    assertEq(AxeGrid.sizeOfCell(cell), s);
                    assertEq(AxeGrid.rateOfCell(cell), r);
                    seen++;
                }
            }
        }
        assertEq(seen, AxeGrid.CELL_CARD);
        assertEq(uint256(AxeGrid.CELL_CARD), uint256(1) << AxeGrid.DEPTH);
    }

    function testFuzz_cellForAgreesWithTheBands(uint8 classId, uint256 lot, uint256 rateBps)
        public
        pure
    {
        classId = uint8(bound(classId, 0, AxeGrid.CLASS_CARD - 1));
        uint16 cell = AxeGrid.cellFor(classId, lot, rateBps);
        assertEq(AxeGrid.classOfCell(cell), classId);
        assertEq(AxeGrid.sizeOfCell(cell), AxeGrid.sizeBand(lot));
        assertEq(AxeGrid.rateOfCell(cell), AxeGrid.rateBand(rateBps));
    }

    function test_aValueSpaceAxeIsARectangleOfCells() public view {
        uint256 covered;
        for (uint16 cell = 0; cell < AxeGrid.CELL_CARD; ++cell) {
            bool yes = AxeGrid.covers(rect, cell);
            if (yes) {
                assertEq(AxeGrid.classOfCell(cell), CLASS);
                assertGe(AxeGrid.sizeOfCell(cell), rect.sizeLo);
                assertLe(AxeGrid.sizeOfCell(cell), rect.sizeHi);
                assertGe(AxeGrid.rateOfCell(cell), rect.rateLo);
                assertLe(AxeGrid.rateOfCell(cell), rect.rateHi);
                covered++;
            }
        }
        uint256 want =
            uint256(rect.sizeHi - rect.sizeLo + 1) * uint256(rect.rateHi - rect.rateLo + 1);
        assertEq(covered, want);
        assertTrue(AxeGrid.covers(rect, cellYes), "a lot and rate inside the box");
        assertFalse(AxeGrid.covers(rect, cellNo), "a lot below the box");
        assertFalse(AxeGrid.covers(rect, cellOtherClass), "the same box, another class");
    }

    function testFuzz_valuesInsideTheAxeLandInACoveredCell(uint256 lot, uint256 rateBps)
        public
        view
    {
        lot = bound(lot, SIZE_LO, SIZE_HI);
        rateBps = bound(rateBps, RATE_LO, RATE_HI);
        assertTrue(AxeGrid.covers(rect, AxeGrid.cellFor(CLASS, lot, rateBps)));
    }

    function test_anHonestOpeningVerifiesAndALieDoesNot() public view {
        (bool covered, bytes32 salt, bytes32[] memory proof) =
            AxeGrid.openingOf(rect, MASTER, cellYes);
        assertTrue(covered, "the yes cell is inside the rectangle");
        assertTrue(AxeGrid.verify(root, cellYes, covered, salt, proof), "honest yes");
        assertFalse(AxeGrid.verify(root, cellYes, !covered, salt, proof), "flipped bit");
        assertFalse(
            AxeGrid.verify(root, cellNo, covered, salt, proof),
            "the same opening at another cell"
        );
        assertFalse(
            AxeGrid.verify(root, cellYes, covered, bytes32(uint256(1)), proof), "wrong salt"
        );

        bytes32[] memory short = new bytes32[](AxeGrid.DEPTH - 1);
        assertFalse(AxeGrid.verify(root, cellYes, covered, salt, short), "short proof");

        bytes32[] memory broken = new bytes32[](AxeGrid.DEPTH);
        for (uint256 i = 0; i < proof.length; ++i) {
            broken[i] = proof[i];
        }
        broken[0] = bytes32(uint256(1));
        assertFalse(AxeGrid.verify(root, cellYes, covered, salt, broken), "corrupt sibling");

        (bool noCover, bytes32 noSalt, bytes32[] memory noProof) =
            AxeGrid.openingOf(rect, MASTER, cellNo);
        assertFalse(noCover, "the no cell is outside the rectangle");
        assertTrue(AxeGrid.verify(root, cellNo, noCover, noSalt, noProof), "honest no");
        assertFalse(
            AxeGrid.verify(root, cellNo, true, noSalt, noProof), "a no cannot be flipped to yes"
        );
    }

    function test_theSaltStopsEnumeration() public view {
        bytes32 other = AxeGrid.rootOf(rect, keccak256("another-lender"));
        assertTrue(other != root, "two masters, two roots");
        (bool covered, bytes32 salt, bytes32[] memory proof) =
            AxeGrid.openingOf(rect, MASTER, cellYes);
        assertFalse(
            AxeGrid.verify(other, cellYes, covered, salt, proof),
            "an opening under one master does not open the other"
        );
        assertTrue(
            AxeGrid.leafOf(cellYes, true, AxeGrid.saltOf(MASTER, cellYes))
                != AxeGrid.leafOf(cellYes, true, AxeGrid.saltOf(keccak256("x"), cellYes)),
            "the leaf moves with the salt"
        );
    }

    function testFuzz_everyCellOfTheFixtureAxeOpens(uint16 cell) public view {
        cell = uint16(bound(cell, 0, AxeGrid.CELL_CARD - 1));
        (bool covered, bytes32 salt, bytes32[] memory proof) =
            AxeGrid.openingOf(rect, MASTER, cell);
        assertEq(covered, AxeGrid.covers(rect, cell));
        assertTrue(AxeGrid.verify(root, cell, covered, salt, proof));
    }

    function test_aProofIsAlwaysElevenWords() public view {
        (,, bytes32[] memory yesProof) = AxeGrid.openingOf(rect, MASTER, cellYes);
        (,, bytes32[] memory noProof) = AxeGrid.openingOf(rect, MASTER, cellNo);
        assertEq(yesProof.length, AxeGrid.DEPTH);
        assertEq(noProof.length, AxeGrid.DEPTH);
        assertEq(AxeGrid.DEPTH, 11);
    }

    function _venueBucket(uint256 v) private pure returns (uint256 b) {
        while (v >= 10) {
            v /= 10;
            b += 1;
        }
    }

    function _bareBoard() private returns (AxeBoard) {
        OrderBookStub stub = new OrderBookStub(0.1 ether);
        return new AxeBoard(
            ISealedOrderBook(address(stub)),
            IRespondentRegistry(address(0)),
            IDisclosurePolicy(address(0)),
            0.01 ether,
            0.36 ether + 1,
            1 hours,
            4 hours,
            4
        );
    }
}

contract OrderBookStub is ISealedOrderBook {
    uint256 public immutable override commitBond;

    constructor(uint256 bond_) {
        commitBond = bond_;
    }

    function commitments(bytes32) external pure returns (address, uint64, bool, bool, uint256) {
        return (address(0), 0, false, false, 0);
    }
}
