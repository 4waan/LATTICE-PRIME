// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {CallAuction} from "../src/market/CallAuction.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @notice The preimage vectors the client renders, asserted against the
///         contract that will re-hash them.
///
/// @dev `commitmentOf` is public and pure "so the client and the contract cannot
///      disagree about the preimage", and nothing checked that until this file.
///      `tools/commitment.mjs` computes the same six words for the preview and
///      `tools/commitment.test.mjs` holds the vectors below. Both sides carry the
///      same literals, so a change to one that misses the other fails here.
contract CommitmentVectorsTest is Test, PolicyFixture {
    /// The parameters `OrderBook.t.sol` deploys. The preview prints them as
    /// figures a trader is asked to act on.
    uint64 constant DELAY = 5 minutes;
    uint64 constant WINDOW = 30 minutes;
    uint256 constant BOND = 0.1 ether;
    uint64 constant ROUND = 1 days;
    uint64 constant REST = 7;
    /// At the floor, where the house fixture sits.
    uint256 constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

    OrderBook book;

    function setUp() public {
        _deployPolicy(asDeployed());
        book = new OrderBook(DELAY, WINDOW, BOND, FEE, params, ROUND, REST);
    }

    function test_theDomainSeparatorIsWhatTheClientAssumes() public view {
        assertEq(
            book.DOMAIN_ORDER(),
            0x6d04045e7ab73fdb5477bc72228c72a7f596d3790608f982e92be89ae991107d
        );
    }

    function test_theClientsVectorsAreTheContractsVectors() public view {
        assertEq(
            book.commitmentOf(
                address(0x000000000000000000000000000000000000a11c),
                OrderBook.Side.SELL,
                1_000_000,
                500,
                bytes32(uint256(42))
            ),
            0x087d6fecb7ba175bbe38e107a77c79d0e97987a6777aecfc22587480585f0d55
        );
        assertEq(
            book.commitmentOf(address(0), OrderBook.Side.BUY, 0, 0, bytes32(0)),
            0x04d63799f526c3f4a78284ed6044f1b2eb59c3a7694f28cb577537b1a627297a
        );
        assertEq(
            book.commitmentOf(
                address(type(uint160).max),
                OrderBook.Side.SELL,
                type(uint128).max,
                type(uint128).max,
                bytes32(type(uint256).max)
            ),
            0xa81015b59fe8780581d4cd24ba1dcc34428c3d343edcd99da11735cc10cfa8ad
        );
        assertEq(
            book.commitmentOf(
                address(0x00000000000000000000000000000000000A11cE),
                OrderBook.Side.BUY,
                9_876_543,
                42,
                bytes32(0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef)
            ),
            0xa4f0ab0ee91b3505d6e38cc7f26cd23fac3e854fdd08eecb73a72ebb6a282930
        );
    }

    /// @dev The preview hardcodes these so it can price an exit before the
    ///      trader has an order, so every figure it prints can go stale in
    ///      silence. A signing screen quoting a bond the contract will not charge
    ///      fails the same way as one quoting the wrong hash, more quietly.
    function test_theFiguresThePreviewPrintsAreTheDeployedFigures() public view {
        assertEq(book.revealDelay(), 300, "DELAY");
        assertEq(book.revealWindow(), 1800, "WINDOW");
        assertEq(book.commitBond(), 100000000000000000, "BOND");
        assertEq(book.cancelFee(), 14285714285714286, "FEE");
        assertEq(book.restRounds(), 7, "REST");
        assertEq(book.roundLength(), 86400, "ROUND");
    }

    /// @dev The one bound `commit` cannot enforce: it takes 32 bytes and cannot
    ///      see the price inside them, so a price at or past this seals and then
    ///      reverts at reveal with the bond already posted. The preview refuses
    ///      it at entry against this number.
    function test_thePreviewsRangeBoundIsTheAuctionsRangeBound() public pure {
        assertEq(CallAuction.SCALE_LIMIT, 1 << 96);
    }

    /// @dev `minimumCancelFee` is the floor the constructor enforces, not the
    ///      fee itself. The preview prints the derived figure, so it is right
    ///      only while the venue deploys at the floor.
    function test_theDeployedFeeIsTheDerivedFloor() public view {
        assertEq(book.cancelFee(), book.minimumCancelFee(BOND, DELAY, WINDOW));
    }
}
