// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {OrderBook} from "./OrderBook.sol";
import {CallAuction} from "./CallAuction.sol";
import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {ICompliance} from "../interfaces/ICompliance.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";
import {VolumeCap} from "../policy/VolumeCap.sol";

/// @title MatchingEngine
/// @notice The half of the book that was named in a comment and not built:
///         clearing, and settlement against ATS.
///
/// ## What was actually missing, which was not "a match function"
///
/// `OrderBook` shipped with a comment where `match` would be, naming two open
/// matrix cells as blockers. The census of what the contract had left undone was
/// longer than that comment and one entry on it was a security hole rather than
/// an omission:
///
/// | | undelivered | consequence |
/// |---|---|---|
/// | 1 | the revealed-id list was appended to and read by nothing but its own length | the book accumulated and never cleared |
/// | 2 | `Order.filled` was written once, as zero | no partial fill accounting existed |
/// | 3 | `Order.revealedAt` was written and never read | a priority field with no priority rule |
/// | 4 | `Side` was stored and never used to segregate | there were not two sides of a book |
/// | 5 | **the bond was returned at reveal** | **a revealed order was an unfunded promise** |
/// | 6 | no token address anywhere | the book could not settle anything |
/// | 7 | `VolumeCap.record` had no production caller | Article 5 counted zero volume forever |
/// | 8 | a row ceiling but no budget accumulator | MA-04 unfixed at the site where repeated disclosure lives |
///
/// Row 5 is the one that mattered. an invariant says a bid that cannot fund cannot
/// win, and between reveal and cross there was nothing at stake at all. The fix
/// is in two places: `OrderBook` keeps the bond, and `_bind` below refuses a
/// reveal that is not backed in the asset or in cash.
///
/// ## The shape: a discrete-round uniform-price call auction with resting orders
///
/// Not a continuous book. `CallAuction` carries the argument in full; the short
/// form is that continuous price-time priority over a queue averaging 1.6 orders
/// a day is theatre, and the only timestamp a commit-and-reveal book has is the
/// reveal, which the trader chooses. A call auction has no time priority to
/// manipulate.
///
/// `crossRound` is permissionless, following `Regime.adopt`, `ParameterRoot.adopt`
/// and `VolumeCap.enforce`. **The venue must not choose when to cross**, because
/// choosing when to cross is choosing the price.
///
/// ## Settlement: which ATS rail, and the one that is not obvious
///
/// Two rails could move the security, and they fail in opposite places.
///
/// | rail | encumbers at reveal | seam C sees the size | seller online at cross |
/// |---|---|---|---|
/// | `createHoldByPartition` then `executeHoldByPartition` | yes | **no** | no |
/// | `authorizeOperatorByPartition` then `operatorTransferByPartition` | no | yes | no |
///
/// Holds win, because an order that is not encumbered at reveal is the unfunded
/// promise this contract exists to remove. `executeHoldByPartition` moves the
/// balance, and `HoldStorageWrapper._validateExecuteHold` permits any destination
/// when the recorded `hold.to` is `address(0)`, so the escrow names the buyer at
/// **execution** time. The counterparty is disclosed at settlement and not at
/// commit, which is the whole reason a sealed book is worth building.
///
/// **The cost of that choice, and it is a real one.** Hold execution reaches seam
/// C as `canTransfer(address(0), to, 0)`: `mesh/transfer-path.md` F-06, shape 3
/// of `SeamJournal._judge`, with the amount withheld. So settling through holds
/// **moves the size policy out of ATS and onto us**. F-06 named that as a design
/// decision owed; this contract is the first one that has to discharge it, and it
/// does so by calling `canTransfer(seller, buyer, amount)` itself, with the real
/// amount, before every execution. See `_permitted`.
///
/// ## The hazard nobody had named
///
/// `beforeExecuteHold` calls `adjustHoldBalances`, which resynchronises the
/// holder's balance adjustment factor, and the pending-adjustment sync fires
/// lazily from entry points all over the facet surface. **So an unrelated third
/// party's transaction can rebase a resting order's backing between the reveal
/// that promised it and the cross that delivers it.** A quantity promised is not
/// a quantity deliverable. A corporate action on the bond is exactly such a
/// transaction.
///
/// The disposition is to snapshot the hold at reveal, read it again at cross, and
/// **void** the order on a mismatch rather than under-deliver into a settlement.
/// A corporate action cancels resting orders, which is what real venues do.
///
/// ## Disclosure, and the loop that makes Article 5 fire
///
/// A cross discloses on four rows: 13 (that a match happened), 5 and 3 (the
/// print), 12 (the counterparties).
///
/// The print **degrades rather than reverts**, which is `SeamJournal`'s Rule A
/// applied at a third site. If the row 5 ceiling or its remaining budget will not
/// carry an exact immediate print, the engine publishes an order of magnitude,
/// and if it will not carry that either it publishes nothing. In every case the
/// trade still settles: a compliant trade must not fail because the venue has run
/// out of things it may say.
///
/// **And a trade whose price was not printed exactly and immediately is a trade
/// that used a hiding mechanism**, so it is recorded against `VolumeCap` as
/// deferred volume. That closes a loop nothing had closed before. Exhaust a row
/// budget with repeated disclosure and the prints go dark; the dark share rises;
/// Article 5's cap fires; `Regime.raiseFloor` lifts the row floors; the venue is
/// compelled to print again. MA-04's repetition attack and MiFIR Article 5 turn
/// out to be the same mechanism seen from two ends, which is the fourth sighting
/// of the accumulator pattern `VolumeCap`'s own header predicted.
contract MatchingEngine is OrderBook {
    /// @notice The ATS token. Holds only; this contract never calls a transfer.
    IHoldByPartition public immutable security;
    bytes32 public immutable partition;

    /// @notice Seam C, called by **us** rather than by ATS.
    /// @dev The F-06 disposition. On the hold rail ATS asks seam C
    ///      `(0, to, 0)`, so the compliance module cannot see the size and any
    ///      size-dependent policy is blind exactly where this venue settles.
    ///      Calling it here with the real triple is the only way the policy runs
    ///      at all. It does not replace ATS's own call; it is the one that
    ///      carries the amount.
    ICompliance public immutable compliance;

    /// @notice Article 5's counter. Attached after construction, once.
    VolumeCap public volumeCap;
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

    /// @notice Rows of `the build notes` section 7.2 the cross discloses on.
    uint16 internal constant ROW_EXEC_PRICE = 5;

    /// @dev **Admitted, and this constant is where the admission lives.**
    ///      Settlement names both sides inside ATS's own transfer, which the
    ///      zero-fork ruling puts beyond our reach. The alternative on the table
    ///      was a netted layer, and `venue/docs/MATCHING.md` section 3 runs the
    ///      arithmetic that alternative rests on: netting hides a counterparty
    ///      only when the netting set holds more than one trade, and at 600
    ///      orders a year a set of five needs a weekly batch while anything worth
    ///      calling private needs the 30 day epoch an earlier measurement already ruled out on
    ///      the time axis for row 16. Same mechanism, same arithmetic, opposite
    ///      row.
    ///
    ///      So row 12 is published at `(exact, {pub}, imm)` and named as a stated
    ///      limit, which is exactly the disposition row 16 already carries. Two
    ///      consequences follow and both are load bearing. Rule B then forbids a
    ///      budget on this row, so the meter charges nothing here, which is
    ///      correct rather than a gap: **our event is not the disclosure, ATS's
    ///      transfer is**, and a meter that withheld our event while the pair
    ///      landed on chain anyway would be certifying a bound that does not
    ///      hold. And row 12 is not in the waived set, so `Regime` cannot narrow
    ///      it underneath us and turn settlement into a revert.
    uint16 internal constant ROW_COUNTERPARTY = 12;

    /// @dev Row 13, and it is **not** the dependent sum the matrix marks it as.
    ///      `dep?` is there because under conditional disclosure the observer set
    ///      is computed from the hidden value. In a call auction over already
    ///      revealed orders under a public deterministic rule, nothing is hidden
    ///      at evaluation time: anyone recomputes the match from the tape. No
    ///      evaluator, therefore no trusted-evaluator surface, which is
    ///      `docs/who-gets-privacy.md` DP-03's owed two column list getting its
    ///      first entry on the column that does not need a proof.
    ///
    ///      The cell is `(pred, {pub}, imm)`, strictly below the `(exact, {pub},
    ///      imm)` already deployed on rows 3 and 4, so **given those rows it
    ///      costs no new disclosure**. Conditional on them, and stated that way.
    uint16 internal constant ROW_MATCH_PREDICATE = 13;

    event RoundCrossed(uint64 indexed round, uint256 priceTwice, uint256 volume);
    /// @notice The print, at whatever granularity the ceiling and the budget
    ///         allow. Magnitudes are base ten orders of magnitude.
    event PrintedCoarse(uint64 indexed round, uint256 priceBucket, uint256 volumeBucket);
    /// @notice Nothing could be printed. The trade still settled.
    event PrintWithheld(uint64 indexed round);
    /// @notice No price executed anything this round. The common case.
    event RoundEmpty(uint64 indexed round);
    /// @notice Row 12, admitted.
    event Settled(bytes32 indexed sellId, bytes32 indexed buyId, uint256 amount, uint256 cost);
    /// @notice Seam C said no to this pair, with the amount it could finally see.
    /// @dev Not a revert. A refused pair simply does not trade this round, and
    ///      the orders rest on. Reverting would let one ineligible counterparty
    ///      stop the venue clearing for everybody.
    event SettlementRefused(bytes32 indexed sellId, bytes32 indexed buyId);
    /// @notice The backing moved under a resting order. It is out of the book.
    event VoidedByRebase(bytes32 indexed id, uint256 promised, uint256 found);
    event VolumeCapAttached(address indexed cap);
    /// @notice The engine tried to hand a retired sell order's lot back. No
    ///         amount: this is housekeeping, not a matrix row.
    event HoldReleaseAttempted(bytes32 indexed id, bool released);

    error RoundStillOpen(uint64 round, uint64 current);
    error AlreadyCrossed(uint64 round);
    error UnexpectedValue(uint256 sent);
    error WrongEscrow(uint256 sent, uint256 want);
    error NotEscrow(address escrow);
    error HoldNamesADestination(address destination);
    error HoldTooSmall(uint256 held, uint256 qty);
    error HoldExpiresTooSoon(uint256 expiry, uint64 needed);
    error OutOfRange(uint128 value);
    error VolumeCapNotAttached();
    error VolumeCapAlreadyAttached();
    error NotInstaller();
    error CapIsNotOurs(address venue);

    constructor(
        uint64 revealDelay_,
        uint64 revealWindow_,
        uint256 commitBond_,
        IDisclosurePolicy policy_,
        uint64 roundLength_,
        uint64 restRounds_,
        IHoldByPartition security_,
        bytes32 partition_,
        ICompliance compliance_
    ) OrderBook(revealDelay_, revealWindow_, commitBond_, policy_, roundLength_, restRounds_) {
        security = security_;
        partition = partition_;
        compliance = compliance_;
        _installer = msg.sender;
    }

    /// @notice Wire Article 5's counter. Once, and it verifies itself.
    /// @dev `VolumeCap` takes its venue at construction and this contract takes
    ///      its cap, which is a construction cycle. Rather than break it with a
    ///      computed address, the cap is attached afterwards and the attachment
    ///      checks `cap.venue() == address(this)`, so a wrong or borrowed cap
    ///      cannot be installed. Until it is, `crossRound` refuses: a venue that
    ///      cannot clear is a better failure than a venue that clears unmetered,
    ///      which is the state item 7 of the census found.
    function attachVolumeCap(VolumeCap cap) external {
        if (msg.sender != _installer) revert NotInstaller();
        if (address(volumeCap) != address(0)) revert VolumeCapAlreadyAttached();
        if (cap.venue() != address(this)) revert CapIsNotOurs(cap.venue());
        volumeCap = cap;
        emit VolumeCapAttached(address(cap));
    }

    // ------------------------------------------------------------- backing

    /// @inheritdoc OrderBook
    /// @dev The larger half of the unfunded-promise fix. A sell must be
    ///      encumbered in ATS and a buy must have paid.
    function _bind(bytes32 id, Order memory o, uint256 backing) internal override {
        // The overflow bound, established once per order rather than per round.
        // `price * qty` is the cash escrow below and `priceTwice * qty` is every
        // settlement afterwards; both must fit, and `CallAuction` re-checks at
        // its own boundary so neither file depends on the other's discipline.
        if (uint256(o.price) >= CallAuction.SCALE_LIMIT) revert OutOfRange(o.price);
        if (uint256(o.qty) >= CallAuction.SCALE_LIMIT) revert OutOfRange(o.qty);

        if (o.side == Side.SELL) {
            if (msg.value != 0) revert UnexpectedValue(msg.value);
            (uint256 amount, uint256 expiry, address escrow, address destination,,,) = security.getHoldForByPartition(
                IHoldTypes.HoldIdentifier({
                    partition: partition, tokenHolder: o.trader, holdId: backing
                })
            );
            // Only this contract may move it, or the seller could release the
            // lot out from under a resting order.
            if (escrow != address(this)) revert NotEscrow(escrow);
            // A hold that already names a destination cannot be executed to the
            // buyer the auction finds, and `_validateExecuteHold` would revert
            // mid-round. It is also the wrong shape: naming the destination at
            // reveal would disclose the counterparty before the match.
            if (destination != address(0)) revert HoldNamesADestination(destination);
            if (amount < o.qty) revert HoldTooSmall(amount, o.qty);
            // It has to outlive the resting window, or the last rounds of the
            // order are unbacked and `HoldExpirationReached` takes the round down.
            uint64 needed = roundEnd(o.lastRound);
            if (expiry < needed) revert HoldExpiresTooSoon(expiry, needed);

            backingOf[id] = Backing({holdId: backing, snapshot: amount, escrow: 0});
        } else {
            // Escrowed at the trader's own bid, paid at the clearing price. The
            // difference comes back when the order retires, which for a fully
            // filled order is the same transaction.
            uint256 want = uint256(o.price) * uint256(o.qty);
            if (msg.value != want) revert WrongEscrow(msg.value, want);
            backingOf[id] = Backing({holdId: 0, snapshot: 0, escrow: want});
        }
    }

    /// @inheritdoc OrderBook
    /// @dev Must not revert. See the base declaration.
    function _unbind(bytes32 id, Order memory o, uint8) internal override {
        Backing storage b = backingOf[id];
        if (o.side == Side.SELL) {
            uint256 remaining = o.qty - o.filled;
            if (remaining != 0 && b.holdId != 0) {
                // Low level, and the failure is reported rather than reverted
                // on. `_unbind` runs inside `crossRound`, so a release that
                // could throw is a release one seller could use to stop the
                // venue clearing. an invariant's fallback covers the failed case: the
                // hold expires and the lot returns to the holder anyway, so the
                // worst outcome is a delay the seller can already price.
                //
                // The event carries no amount, deliberately. It is housekeeping
                // rather than a matrix row, and a row would have to go through
                // `_emitUnder`, which can revert.
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

    /// @notice Clear round `r`. Permissionless, once per round.
    /// @dev The venue does not choose when to cross, and cannot cross a round
    ///      that is still open, so it cannot see a round's own orders and then
    ///      decide whether to run it.
    function crossRound(uint64 r) external nonReentrant {
        if (address(volumeCap) == address(0)) revert VolumeCapNotAttached();
        uint64 now_ = currentRound();
        if (r >= now_) revert RoundStillOpen(r, now_);
        if (crossed[r]) revert AlreadyCrossed(r);
        crossed[r] = true;

        (bytes32[] memory ids, CallAuction.Limit[] memory book) = _assemble(r);
        CallAuction.Cross memory c = CallAuction.clear(book);

        // Row 13 first, because it is the one disclosure a round always makes:
        // that it did or did not cross. A predicate, and the cheapest cell the
        // venue publishes anywhere.
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
    }

    /// @dev The round's book. Voids any sell whose backing moved.
    function _assemble(uint64 r)
        private
        returns (bytes32[] memory ids, CallAuction.Limit[] memory book)
    {
        uint256 n = revealedCount();

        // **Snapshot first, then walk.** `_voidOnRebase` can retire an order,
        // and retirement swaps the last live element into the vacated slot, so
        // the array is being rewritten underneath any loop that indexes it. An
        // ascending walk would skip the element that got swapped down; a
        // descending walk looks safe and is not, because once enough orders have
        // been voided the element swapped down lands *below* the cursor and is
        // visited a second time, putting one order into the round's book twice.
        // Copying costs one word per live order and removes the whole class.
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

    /// @notice The ABAF check. True when the order was voided.
    /// @dev The promise made at reveal was `snapshot` units held. Each fill has
    ///      since executed against that hold and reduced it, so the amount that
    ///      should be there now is `snapshot - filled`. Anything else means the
    ///      hold was rebased by an adjustment factor that fired from a
    ///      transaction this venue never saw, and the order is no longer the
    ///      order that was revealed.
    ///
    ///      Voiding rather than scaling. Scaling the order to the new backing
    ///      would silently change a trader's size after the fact; refusing to
    ///      trade it is what a venue does when a corporate action lands on an
    ///      instrument with a resting book.
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

    /// @dev Price priority is already in the allocation; this only has to move
    ///      the totals. Uniform price means there is no correct pairing, only a
    ///      pairing that moves the right quantity between the right sides, so
    ///      the walk is the cheapest one that does: at most `n + m - 1`
    ///      executions for `n` filled sells and `m` filled buys.
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
                // This buyer trades no more this round. The seller tries the
                // next one; both orders rest on with their unfilled remainder.
                remaining[bi] = 0;
                continue;
            }

            _settleOne(ids[si], ids[bi], amount, c.priceTwice);
            remaining[bi] -= amount;
            remaining[si] -= amount;
            settled += amount;
        }
        // Retirement is a second pass, because retiring inside the walk would
        // move the live array under an index the walk is still using.
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

        // Cash first, and it cannot underflow: the buyer escrowed `bid * qty`,
        // eligibility guarantees `2 * bid >= priceTwice`, and the total filled
        // never exceeds `qty`, so the running cost is bounded by the escrow.
        Backing storage bb = backingOf[buyId];
        bb.escrow -= cost;
        credit[so.trader] += cost;

        so.filled += amount;
        bo.filled += amount;

        // The asset. `hold.to` was required to be zero at reveal, so this is
        // where the buyer is finally named, and this is the disclosure row 12
        // admits: it happens inside ATS whatever this contract emits.
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

    /// @notice Seam C, asked the question ATS cannot ask on this rail.
    /// @dev Defended the way `SeamJournal._granted` defends its own staticcall.
    ///      `try` alone is not enough: a module returning 64 bytes would decode
    ///      and be believed. A module that reverts, or answers in the wrong
    ///      shape, denies rather than permits, because this is the only size
    ///      gate on the settlement path and failing it open would make the gate
    ///      decorative.
    function _permitted(address from, address to, uint256 amount) internal view returns (bool) {
        (bool ok, bytes memory out) = address(compliance)
            .staticcall(abi.encodeCall(ICompliance.canTransfer, (from, to, amount)));
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (bool));
    }

    // ---------------------------------------------------------- the print

    /// @notice Publish the round's price and volume at the finest cell the
    ///         ceiling and the remaining budget allow.
    /// @return exact Whether the exact immediate print went out. A round that
    ///         could not print exactly is a round whose volume used a hiding
    ///         mechanism, and it is recorded against Article 5 as such.
    /// @dev Rule A, third site. `SeamJournal._discloseArrival` degrades an
    ///      arrival record and `RepoVault` withholds a coupon amount; this
    ///      degrades a print. In every case the state transition completes and
    ///      only the venue's speech is rationed, because a compliant trade must
    ///      not fail because the venue has run out of things it may say.
    ///
    ///      Two rows, charged separately and never short circuited: the event
    ///      carries an execution price on row 5 and a volume on row 3, and an
    ///      `&&` would let the size row escape the meter whenever the price row
    ///      was already spent.
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

    /// @dev Order of magnitude, base ten. The same function `SeamJournal` uses,
    ///      and for the same reason: a bucket has to be a stated function of the
    ///      value or `bucketBits` is charging for a disclosure nobody defined.
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
