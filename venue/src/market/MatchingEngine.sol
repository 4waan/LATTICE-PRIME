// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {OrderBook} from "./OrderBook.sol";
import {MatchingEngineBase} from "./MatchingEngineBase.sol";
import {CallAuction} from "./CallAuction.sol";
import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {ICompliance} from "../interfaces/ICompliance.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";
import {VolumeCap} from "../policy/VolumeCap.sol";
import {TradingHalt} from "../policy/TradingHalt.sol";

/// @title MatchingEngine
/// @notice Uniform-price call auction and ATS hold settlement. Extends `OrderBook`.
/// @dev Permissionless `crossRound`: choosing when to cross is choosing the price.
///      Holds, not operator transfer: encumber at reveal. `executeHold` withholds
///      size at seam C (F-06), so this contract re-checks `canTransfer(seller,
///      buyer, amount)` itself. Snapshot the hold at reveal; void on rebase.
///      Print degrades under Rule A; inexact prints count as deferred volume
///      (`VolumeCap`). Clearing: `CallAuction`. Design: `docs/MATCHING.md`.
contract MatchingEngine is MatchingEngineBase, OrderBook {
    /// @notice The ATS token. Holds only; this contract never calls a transfer.
    IHoldByPartition public immutable security;
    bytes32 public immutable partition;

    /// @notice Seam C, asked here with the real amount. ATS's own hold-path call is `(0, to, 0)`.
    ICompliance public immutable compliance;

    /// @notice Article 5's counter. Attached after construction, once.
    VolumeCap public volumeCap;

    /// @notice Article 48(5) halt. Attached once. Gates `crossRound` only.
    TradingHalt public tradingHalt;

    address private immutable _installer;

    /// @param holdId The ATS hold standing behind a sell order. Zero for a buy.
    /// @param snapshot The hold's amount **as read at reveal**. The ABAF
    ///        reference point; see `_voidOnRebase`.
    /// @param escrow Cash still held for a buy order, in minor units.
    struct Backing {
        uint256 holdId;
        uint256 snapshot;
        uint256 escrow;
    }

    mapping(bytes32 => Backing) public backingOf;
    mapping(uint64 => bool) public crossed;

    /// @dev Cancel needs no override: `_bind` runs at reveal, so a pre-reveal
    ///      cancel has nothing for `_unbind` to release.
    constructor(
        uint64 revealDelay_,
        uint64 revealWindow_,
        uint256 commitBond_,
        uint256 cancelFee_,
        IDisclosurePolicy policy_,
        uint64 roundLength_,
        uint64 restRounds_,
        IHoldByPartition security_,
        bytes32 partition_,
        ICompliance compliance_
    )
        OrderBook(
            revealDelay_,
            revealWindow_,
            commitBond_,
            cancelFee_,
            policy_,
            roundLength_,
            restRounds_
        )
    {
        security = security_;
        partition = partition_;
        compliance = compliance_;
        _installer = msg.sender;
    }

    /// @notice Wire Article 5's counter. Once. Checks `cap.venue() == this`.
    function attachVolumeCap(VolumeCap cap) external {
        if (msg.sender != _installer) revert NotInstaller();
        if (address(volumeCap) != address(0)) revert VolumeCapAlreadyAttached();
        if (cap.venue() != address(this)) revert CapIsNotOurs(cap.venue());
        volumeCap = cap;
        emit VolumeCapAttached(address(cap));
    }

    /// @notice Wire Article 48(5)'s halt. Once. Same venue check as the cap.
    function attachTradingHalt(TradingHalt halt) external {
        if (msg.sender != _installer) revert NotInstaller();
        if (address(tradingHalt) != address(0)) revert TradingHaltAlreadyAttached();
        if (halt.venue() != address(this)) revert CapIsNotOurs(halt.venue());
        tradingHalt = halt;
        emit TradingHaltAttached(address(halt));
    }

    // ------------------------------------------------------------- backing

    /// @inheritdoc OrderBook
    /// @dev Sell must be encumbered in ATS; buy must have paid. Bond stays posted.
    function _bind(bytes32 id, Order memory o, uint256 backing) internal override {
        if (uint256(o.price) >= CallAuction.SCALE_LIMIT) revert OutOfRange(o.price);
        if (uint256(o.qty) >= CallAuction.SCALE_LIMIT) revert OutOfRange(o.qty);

        if (o.side == Side.SELL) {
            if (msg.value != 0) revert UnexpectedValue(msg.value);
            (uint256 amount, uint256 expiry, address escrow, address destination,,,) = security.getHoldForByPartition(
                IHoldTypes.HoldIdentifier({
                    partition: partition, tokenHolder: o.trader, holdId: backing
                })
            );
            if (escrow != address(this)) revert NotEscrow(escrow);
            // Named destination cannot be executed to the auction's buyer, and
            // would disclose the counterparty at reveal.
            if (destination != address(0)) revert HoldNamesADestination(destination);
            if (amount < o.qty) revert HoldTooSmall(amount, o.qty);
            uint64 needed = roundEnd(o.lastRound);
            if (expiry < needed) revert HoldExpiresTooSoon(expiry, needed);

            backingOf[id] = Backing({holdId: backing, snapshot: amount, escrow: 0});
        } else {
            uint256 want = uint256(o.price) * uint256(o.qty);
            if (msg.value != want) revert WrongEscrow(msg.value, want);
            backingOf[id] = Backing({holdId: 0, snapshot: 0, escrow: want});
        }
    }

    /// @inheritdoc OrderBook
    /// @dev Must not revert: runs inside permissionless `crossRound`. Failed
    ///      release is reported; the hold expires back to the holder anyway.
    function _unbind(bytes32 id, Order memory o, uint8) internal override {
        Backing storage b = backingOf[id];
        if (o.side == Side.SELL) {
            uint256 remaining = o.qty - o.filled;
            if (remaining != 0 && b.holdId != 0) {
                (bool released,) = address(security)
                    .call(
                        abi.encodeCall(
                            IHoldByPartition.releaseHoldByPartition,
                            (
                                IHoldTypes.HoldIdentifier({
                                    partition: partition,
                                    tokenHolder: o.trader,
                                    holdId: b.holdId
                                }),
                                remaining
                            )
                        )
                    );
                emit HoldReleaseAttempted(id, released);
            }
        } else if (b.escrow != 0) {
            uint256 back = b.escrow;
            b.escrow = 0;
            credit[o.trader] += back;
        }
    }

    // --------------------------------------------------------------- the cross

    /// @notice Clear round `r`. Permissionless, once. Cannot cross an open round.
    function crossRound(uint64 r) external nonReentrant {
        if (address(volumeCap) == address(0)) revert VolumeCapNotAttached();
        if (address(tradingHalt) == address(0)) revert TradingHaltNotAttached();
        uint64 now_ = currentRound();
        if (r >= now_) revert RoundStillOpen(r, now_);
        if (crossed[r]) revert AlreadyCrossed(r);

        // Halted rounds retry; voiding would take orders from people who stayed.
        // Limits still bind, so a late cross executes inside the named price.
        if (tradingHalt.haltedNow()) {
            uint64 until = tradingHalt.haltedUntil();
            emit CrossRefusedWhileHalted(r, until);
            revert VenueHalted(until);
        }
        crossed[r] = true;

        (bytes32[] memory ids, CallAuction.Limit[] memory book) = _assemble(r);
        CallAuction.Cross memory c = CallAuction.clear(book);

        _emitUnder(bytes32(uint256(r)), ROW_MATCH_PREDICATE, L.G_PRED, L.T_IMM);
        if (!c.crossed) {
            emit RoundEmpty(r);
            return;
        }

        bool exact = _print(r, c.priceTwice, c.volume);
        uint256 settled = _settleAll(ids, book, c);

        uint256 notional = CallAuction.notional(c.priceTwice, settled);
        // forge-lint: disable-next-line(unsafe-typecast)
        volumeCap.record(uint128(notional), exact ? 0 : uint128(notional));

        // The breaker sees the price this round cleared at, which is the first
        // moment it exists. It halts the next round, never this one.
        tradingHalt.observe(c.priceTwice);
    }

    /// @dev The round's book. Voids any sell whose backing moved.
    function _assemble(uint64 r)
        private
        returns (bytes32[] memory ids, CallAuction.Limit[] memory book)
    {
        uint256 n = revealedCount();

        // Snapshot first: `_voidOnRebase` retires and swap-pops, so walking
        // `_live` in either direction can skip or double-visit.
        bytes32[] memory snapshot = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            snapshot[i] = liveAt(i);
        }

        bytes32[] memory scratch = new bytes32[](n);
        uint256 k;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = snapshot[i];
            if (!eligibleIn(id, r)) continue;
            if (_voidOnRebase(id)) continue;
            scratch[k++] = id;
        }
        ids = new bytes32[](k);
        book = new CallAuction.Limit[](k);
        for (uint256 i = 0; i < k; ++i) {
            ids[i] = scratch[i];
            Order storage o = orders[scratch[i]];
            book[i] = CallAuction.Limit({
                buy: o.side == Side.BUY, price: o.price, qty: o.qty - o.filled
            });
        }
    }

    /// @dev Expected remaining is `snapshot - filled`. Anything else is a rebase
    ///      from a transaction this venue never saw. Void rather than rescale.
    function _voidOnRebase(bytes32 id) private returns (bool) {
        Order storage o = orders[id];
        if (o.side != Side.SELL) return false;
        Backing storage b = backingOf[id];
        (uint256 amount,,,,,,) = security.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({
                partition: partition, tokenHolder: o.trader, holdId: b.holdId
            })
        );
        uint256 expected = b.snapshot - o.filled;
        if (amount == expected) return false;
        emit VoidedByRebase(id, expected, amount);
        _retire(id, RETIRE_VOIDED);
        return true;
    }

    /// @dev Uniform price: any pairing that moves the cleared quantity is correct.
    ///      At most `n + m - 1` executions. Retire in a second pass.
    function _settleAll(
        bytes32[] memory ids,
        CallAuction.Limit[] memory book,
        CallAuction.Cross memory c
    ) private returns (uint256 settled) {
        uint128[] memory remaining = CallAuction.allocate(book, c);
        uint256 n = ids.length;
        uint256 bi;
        uint256 si;
        while (true) {
            while (bi < n && (!book[bi].buy || remaining[bi] == 0)) ++bi;
            while (si < n && (book[si].buy || remaining[si] == 0)) ++si;
            if (bi >= n || si >= n) break;

            uint128 amount = remaining[bi] < remaining[si] ? remaining[bi] : remaining[si];
            address seller = orders[ids[si]].trader;
            address buyer = orders[ids[bi]].trader;

            if (!_permitted(seller, buyer, amount)) {
                emit SettlementRefused(ids[si], ids[bi]);
                remaining[bi] = 0;
                continue;
            }

            _settleOne(ids[si], ids[bi], amount, c.priceTwice);
            remaining[bi] -= amount;
            remaining[si] -= amount;
            settled += amount;
        }
        // Retirement is a second pass: retiring inside the walk mutates `_live`.
        for (uint256 i = 0; i < n; ++i) {
            Order storage o = orders[ids[i]];
            if (o.filled >= o.qty) _retire(ids[i], RETIRE_FILLED);
        }
    }

    function _settleOne(bytes32 sellId, bytes32 buyId, uint128 amount, uint256 priceTwice)
        private
    {
        Order storage so = orders[sellId];
        Order storage bo = orders[buyId];
        uint256 cost = CallAuction.notional(priceTwice, amount);

        Backing storage bb = backingOf[buyId];
        bb.escrow -= cost;
        credit[so.trader] += cost;

        so.filled += amount;
        bo.filled += amount;

        // `hold.to` was zero at reveal; the buyer is named here (row 12 / ATS).
        security.executeHoldByPartition(
            IHoldTypes.HoldIdentifier({
                partition: partition, tokenHolder: so.trader, holdId: backingOf[sellId].holdId
            }),
            bo.trader,
            amount
        );

        if (_emitUnder(sellId, ROW_COUNTERPARTY, L.G_EXACT, L.T_IMM)) {
            emit Settled(sellId, buyId, amount, cost);
        }
    }

    /// @dev Fail closed: wrong-length or reverting module denies. This is the
    ///      only size gate on the settlement path.
    function _permitted(address from, address to, uint256 amount) internal view returns (bool) {
        (bool ok, bytes memory out) = address(compliance)
            .staticcall(abi.encodeCall(ICompliance.canTransfer, (from, to, amount)));
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (bool));
    }

    // ---------------------------------------------------------- the print

    /// @notice Finest printable cell the ceiling and remaining budget allow.
    /// @return exact True iff the exact immediate print went out (not deferred volume).
    /// @dev Rule A: two rows, charged separately. Short-circuit would let size
    ///      escape the meter whenever price was already spent.
    function _print(uint64 r, uint256 priceTwice, uint256 volume) private returns (bool exact) {
        uint32 exactNow = L.point(L.G_EXACT, L.T_IMM);
        uint32 bucketNow = L.point(L.G_BUCKET, L.T_IMM);
        uint32 cPrice = policy.ceilingFor(ROW_EXEC_PRICE);
        uint32 cSize = policy.ceilingFor(ROW_ORDER_SIZE);

        if (L.permits(cPrice, exactNow) && L.permits(cSize, exactNow)) {
            bool okP = DisclosureMeter.spend(_meter, policy, ROW_EXEC_PRICE, L.G_EXACT);
            bool okS = DisclosureMeter.spend(_meter, policy, ROW_ORDER_SIZE, L.G_EXACT);
            if (okP && okS) {
                emit RoundCrossed(r, priceTwice, volume);
                return true;
            }
        }
        if (L.permits(cPrice, bucketNow) && L.permits(cSize, bucketNow)) {
            bool okP = DisclosureMeter.spend(_meter, policy, ROW_EXEC_PRICE, L.G_BUCKET);
            bool okS = DisclosureMeter.spend(_meter, policy, ROW_ORDER_SIZE, L.G_BUCKET);
            if (okP && okS) {
                emit PrintedCoarse(r, _bucket(priceTwice / 2), _bucket(volume));
                return false;
            }
        }
        emit PrintWithheld(r);
        return false;
    }

    /// @dev Base-ten magnitude. Same function `SeamJournal` uses.
    function _bucket(uint256 v) private pure returns (uint256 b) {
        while (v >= 10) {
            v /= 10;
            b += 1;
        }
    }

    // ------------------------------------------------------------- reads

    /// @notice What a client needs to check a round without replaying it.
    function quote(uint64 r)
        external
        view
        returns (bool willCross, uint256 priceTwice, uint256 volume)
    {
        uint256 n = revealedCount();
        CallAuction.Limit[] memory book = new CallAuction.Limit[](n);
        uint256 k;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = liveAt(i);
            if (!eligibleIn(id, r)) continue;
            Order storage o = orders[id];
            book[k++] = CallAuction.Limit({
                buy: o.side == Side.BUY, price: o.price, qty: o.qty - o.filled
            });
        }
        assembly {
            mstore(book, k)
        }
        CallAuction.Cross memory c = CallAuction.clear(book);
        return (c.crossed, c.priceTwice, c.volume);
    }
}
