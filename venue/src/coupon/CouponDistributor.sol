// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICashToken} from "../interfaces/ICashToken.sol";
import {ICouponSchedule} from "../interfaces/ICouponSchedule.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {MerkleSet} from "../merkle/MerkleSet.sol";

/// @title CouponDistributor
/// @notice The money. A funded coupon, a published entitlement root, and claims
///         against it. `docs/RULEBOOK.md` §8.
/// @dev `CouponSchedule` is the issuer's promise; this is the leg that keeps it.
///      Before both of them the venue had `RepoVault.payThrough` and nothing on
///      the other side of it: the pass-through existed and the payment it passed
///      through did not.
///
/// ## Declared, funded, then claimable, in that order
///
/// `declare` refuses unless the contract already holds the cash. **A declaration
/// nobody funded is not a declaration**, it is a promise with a merkle root
/// attached, and the failure mode of accepting one is that the shortfall is
/// discovered by the last claimant rather than by the issuer. So the check is at
/// declaration, against `committed`, which is the sum of every live obligation
/// this contract has taken on and has not yet paid or swept.
///
/// The invariant that buys is one line and it holds across every path here:
///
///     cash.balanceOf(address(this))  >=  committed
///
/// `invariant_theContractNeverOwesMoreThanItHolds` is that claim, and it is an
/// invariant rather than a unit test because it is a statement about every
/// reachable state and not about one sequence. Every unit test in
/// `test/CouponDistributor.t.sol` that moves money asserts it as well, at the
/// end of the sequence it wrote.
///
/// ## The entitlement tree
///
/// Keccak, over `(holder, amount)` pairs, built off chain from the mirror node
/// at the record date. It is `MerkleSet`, the same leaf shape, the same node
/// rule and the same odd-node promotion `ParameterRoot` publishes its parameter
/// set under, because a repository with two hand-written merkle trees has two
/// answers to "what is the root of this set" and no way to notice when they
/// disagree.
///
/// Two departures from the plan's `claim(index, amount, proof)`, and both are
/// forced by that decision rather than chosen:
///
/// - **`position` is an argument.** `MerkleSet` hashes an ordered pair and never
///   sorts it, which is what lets an odd node be promoted instead of duplicated.
///   A positional tree needs a direction per level and the position is where
///   those come from.
/// - **`holders` is pinned at `declare`.** With promotion, the number of proof
///   elements a path needs depends on the tree's width, so the width is part of
///   what the issuer published rather than part of what a claimant asserts.
///   `MerkleSet.verify` says the rest.
///
/// The coupon index is inside the leaf. Without it, a holder with a valid proof
/// against coupon 3 has a valid proof against every other coupon whose tree
/// contains the same `(holder, amount)` pair, and this contract cannot tell the
/// two apart because the leaf is all it ever sees.
/// `test_aProofFromAnotherCouponIsRefused` is that claim.
///
/// ## What is public here that this contract did not make public
///
/// The entitlement root is published, and Hedera balances are readable from the
/// mirror node, so a determined observer can reconstruct who held what at the
/// record date without any help from this contract. That is a property of a
/// public ledger and not of this design, and it is recorded in `docs/HCS.md`'s
/// register alongside the relay's ability to stall rather than argued away.
/// What this contract does control is its own event stream, and `Claimed`
/// carries no amount for the reason `RepoVaultBase.Failing` carries none.
///
/// ## Why `claim` is not metered and `declare` is
///
/// `declare` routes through `DisclosureView._emitUnder` at row 7, following
/// `PrimeOracle.finalize`: a ceiling breach reverts, and a venue that may not
/// publish a corporate action is a venue that must not declare one. Nothing is
/// stranded by that refusal, because the cash is still uncommitted and
/// `sweepUncommitted` returns it.
///
/// `claim` and `sweep` do not, and the omission is the design, in the register
/// `FreezeList` uses. Metering an event means withholding it when a row's
/// coalition budget is spent, and `_emitUnder` reverts rather than withholds
/// when a ceiling is breached. Either behaviour on a payment path is wrong:
/// a payment the venue may not announce is still a payment somebody is owed,
/// and a coupon that cannot be claimed because the disclosure budget is spent is
/// a bond that stops paying for a reason that has nothing to do with the bond.
/// `test_aCouponPaysWhateverTheMatrixSays` is that claim.
contract CouponDistributor is DisclosureView {
    // ------------------------------------------------------------ the rows

    /// @dev A coupon declaration is a corporate action on the instrument: an
    ///      index, a record date, and the size of the pool. Terms of the bond,
    ///      where the maturity date and the clean price already sit.
    uint16 internal constant ROW_ASSET = 7;

    // ------------------------------------------------------- the tree tags

    bytes32 public constant DOMAIN_LEAF = keccak256("hedera2026.coupon.entitlement.leaf.v1");
    bytes32 public constant DOMAIN_NODE = keccak256("hedera2026.coupon.entitlement.node.v1");

    // ------------------------------------------------------------ the seats

    /// @notice The bond's coupon calendar. `src/coupon/CouponSchedule.sol`.
    ICouponSchedule public immutable schedule;

    /// @notice The asset a coupon settles in. An HTS token on chain 296.
    ICashToken public immutable cash;

    /// @notice Funds a declaration, and receives what nobody claimed.
    /// @dev The only seat here with any discretion, and the discretion it has is
    ///      to declare or not to declare. It cannot move a root, cannot stop a
    ///      claim, and cannot take back a declaration it funded before the
    ///      claim window closes.
    address public immutable issuer;

    /// @notice How long a declared coupon stays claimable.
    uint64 public immutable claimWindow;

    /// @notice The paying agent's charge, in basis points. `docs/RULEBOOK.md` §8.
    /// @dev **This number does not charge anything.** The charge is a fractional
    ///      custom fee on the cash token's own fee schedule, collected by HTS
    ///      during the transfer in `claim`, and HTS is the only thing that can
    ///      change it. What this immutable is for is the tariff: a
    ///      `Rulebook.Charge` names a `(source, reader)` pair so that
    ///      `reconcile` can read the published number back off chain, and a
    ///      tariff line with no mechanism behind it is the pattern §8 exists to
    ///      refuse.
    ///
    ///      So the line is honest about what it is: this is the fee schedule the
    ///      deployment set, declared at construction, and `make client` reads
    ///      the token's actual fees off the mirror node and fails if the two
    ///      disagree. Reading it live off the HTS system contract at `0x167` was
    ///      the alternative and it was not taken, because that read has to be
    ///      total for `reconcile`'s sake and a total read of a system contract
    ///      that does not exist on every chain answers zero, which is a tariff
    ///      line reporting no charge on precisely the chains where nobody can
    ///      check it.
    uint256 public immutable payingAgentFeeBps;

    // ----------------------------------------------------------- the state

    /// @param root The entitlement tree over `(holder, amount)` at `recordDate`.
    /// @param holders Leaves in that tree. Pins its shape. See `MerkleSet.verify`.
    /// @param total What the issuer funded and the most this coupon can ever pay.
    /// @param remaining `total` less what has been claimed. Zero after a sweep.
    struct Declaration {
        bytes32 root;
        uint64 recordDate;
        uint64 declaredAt;
        uint32 holders;
        uint256 total;
        uint256 remaining;
        bool swept;
    }

    mapping(uint256 => Declaration) private _declared;

    /// @notice Set **before** the transfer in `claim`, so an external call
    ///         cannot re-enter into a second payment.
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Every live obligation this contract has taken on. See the header.
    uint256 public committed;

    // -------------------------------------------------------------- events

    /// @notice Row 7, through the meter. See the class comment.
    event Declared(
        uint256 indexed index, uint64 recordDate, bytes32 root, uint32 holders, uint256 total
    );

    /// @notice Never withheld, and no amount.
    /// @dev The amount is `lot x face x rate x period`, and face, rate and
    ///      period are all public terms of the bond, so an amount in this log
    ///      divides out to the holder's exact position at the record date. Row
    ///      14 puts that at `(none, {}, never)`, which is the same reasoning
    ///      `RepoVaultBase.Failing` carries.
    ///
    ///      **That is a statement about what this venue says, not a privacy
    ///      claim.** The cash token's own `Transfer` log carries the amount, and
    ///      the entitlement root was published at `declare`. The venue declining
    ///      to repeat a number the ledger already holds is worth exactly what it
    ///      is worth, which is why the class comment states the limit rather
    ///      than leaving this event to imply otherwise.
    event Claimed(uint256 indexed index, address indexed holder);

    event Swept(uint256 indexed index, uint256 amount);

    /// @dev Cash that reached this contract and was never committed to a
    ///      declaration. An aggregate over no holder, so no row.
    event UncommittedReturned(uint256 amount);

    // -------------------------------------------------------------- errors

    error NotIssuer();
    error NoSuchCoupon(uint256 index);
    error AlreadyDeclared(uint256 index);
    error NotDeclared(uint256 index);
    error CouponNotYetDue(uint256 index, uint64 dueAt);
    error RecordDateInTheFuture(uint64 recordDate, uint64 now_);
    error RecordDateAfterCoupon(uint64 recordDate, uint64 dueAt);
    error EmptyDeclaration();
    error Underfunded(uint256 held, uint256 needed);
    error AlreadyClaimed(uint256 index, address holder);
    error BadProof(uint256 index, address holder);
    error ExceedsRemaining(uint256 index, uint256 amount, uint256 remaining);
    error ClaimWindowOpen(uint64 until);
    /// @dev `closesAt` and not `at`. `ethers` decodes a custom error's arguments
    ///      into an array-like `Result`, so a member called `at` resolves to
    ///      `Array.prototype.at` and a client reads a function where a timestamp
    ///      should be. `tools/gen-app.mjs` refuses to bundle an ABI with a
    ///      colliding member name, and it refused this one.
    error ClaimWindowClosed(uint64 closesAt);
    error AlreadySwept(uint256 index);
    error NothingUncommitted();
    error TransferFailed(address to, uint256 amount);
    error FeeChargedOnTop(uint256 left, uint256 amount);
    error ZeroAddress();

    // --------------------------------------------------------- construction

    constructor(
        IDisclosurePolicy policy_,
        ICouponSchedule schedule_,
        ICashToken cash_,
        address issuer_,
        uint64 claimWindow_,
        uint256 payingAgentFeeBps_
    ) DisclosureView(policy_) {
        if (
            address(schedule_) == address(0) || address(cash_) == address(0)
                || issuer_ == address(0)
        ) {
            revert ZeroAddress();
        }
        schedule = schedule_;
        cash = cash_;
        issuer = issuer_;
        claimWindow = claimWindow_;
        payingAgentFeeBps = payingAgentFeeBps_;
    }

    // ------------------------------------------------------------- declare

    /// @notice Publish a funded coupon and the tree of who is owed what.
    /// @dev The issuer, because naming who is paid is the issuer's act and a
    ///      permissionless `declare` is anyone naming who is paid. Every other
    ///      entry point on this contract is open.
    ///
    ///      **Nothing moves a root afterwards.** There is no amend, no restate
    ///      and no re-declare: `AlreadyDeclared` is the whole of the mechanism,
    ///      because a distributor that could restate entitlements after
    ///      publishing them is a distributor whose root means nothing.
    /// @param index The coupon, as the schedule numbers it.
    /// @param recordDate When the balances behind `entitlementRoot` were read.
    /// @param entitlementRoot `MerkleSet` over `(holder, amount)`, index-scoped.
    /// @param holders Leaves in the tree. Pins its shape; see `MerkleSet.verify`.
    /// @param total The pool. This contract will never pay more than it on this
    ///        coupon, whatever the tree says, which is what makes a mis-declared
    ///        total a refused claim rather than another coupon's funds.
    function declare(
        uint256 index,
        uint64 recordDate,
        bytes32 entitlementRoot,
        uint32 holders,
        uint256 total
    ) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (index >= schedule.count()) revert NoSuchCoupon(index);
        if (_declared[index].declaredAt != 0) revert AlreadyDeclared(index);
        if (entitlementRoot == bytes32(0) || holders == 0 || total == 0) {
            revert EmptyDeclaration();
        }

        uint64 dueAt = schedule.dateOf(index);
        // A coupon paid before it falls due is a coupon paid on terms the bond
        // does not have.
        if (block.timestamp < dueAt) revert CouponNotYetDue(index, dueAt);
        // A record date the chain has not reached is a set of balances nobody
        // could have read. The mirror node is where this tree came from and the
        // mirror node cannot answer about the future.
        if (recordDate > block.timestamp) {
            revert RecordDateInTheFuture(recordDate, uint64(block.timestamp));
        }
        if (recordDate > dueAt) revert RecordDateAfterCoupon(recordDate, dueAt);

        // Funded or refused, and checked against everything already owed rather
        // than against this declaration alone. A balance that covers this coupon
        // because it is still holding the last one's unclaimed residue is not a
        // funded declaration.
        uint256 held = cash.balanceOf(address(this));
        uint256 needed = committed + total;
        if (held < needed) revert Underfunded(held, needed);

        _declared[index] = Declaration({
            root: entitlementRoot,
            recordDate: recordDate,
            declaredAt: uint64(block.timestamp),
            holders: holders,
            total: total,
            remaining: total,
            swept: false
        });
        committed = needed;

        if (_emitUnder(bytes32(index), ROW_ASSET, L.G_EXACT, L.T_IMM)) {
            emit Declared(index, recordDate, entitlementRoot, holders, total);
        }
    }

    // --------------------------------------------------------------- claim

    /// @notice Pay `holder` what the published tree says they are owed.
    /// @dev **Permissionless in `msg.sender`, fixed in destination.** Anyone may
    ///      call it and the funds only ever go to the holder named in the leaf,
    ///      which is the same shape `RepoVault.markToMarket` and
    ///      `ParameterRoot.adopt` already take in this venue and it buys the
    ///      same two things: a holder who cannot pay gas is still paid, and the
    ///      timing of a claim stops being a signal about who chose to look.
    ///
    ///      Marked claimed before the transfer. The cash token is HTS and not
    ///      code this repository controls, and the ordering is what makes that
    ///      irrelevant: a re-entrant call finds `claimed` already set and
    ///      reverts `AlreadyClaimed` before reaching a second transfer.
    /// @param position Where the leaf sits in the tree. See the class comment.
    function claim(
        uint256 index,
        address holder,
        uint256 position,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        Declaration storage d = _declared[index];
        if (d.declaredAt == 0) revert NotDeclared(index);
        uint64 closesAt = d.declaredAt + claimWindow;
        // After the window the residue is the issuer's, so a claim landing after
        // it is refused whether or not the sweep has happened yet. Deciding this
        // on `swept` instead would make the answer depend on whether anybody
        // had got round to calling `sweep`.
        if (block.timestamp >= closesAt) revert ClaimWindowClosed(closesAt);
        if (claimed[index][holder]) revert AlreadyClaimed(index, holder);

        bytes32 leaf =
            MerkleSet.leafOf(DOMAIN_LEAF, index, bytes32(uint256(uint160(holder))), amount);
        if (!MerkleSet.verify(d.root, DOMAIN_NODE, leaf, position, d.holders, proof)) {
            revert BadProof(index, holder);
        }

        // The pool bounds the tree, not the other way round. A tree whose leaves
        // sum past `total`, whether mis-built or signed off by an issuer who
        // then wanted a second coupon's money, runs out here, on this coupon,
        // rather than reaching into another declaration's funds.
        uint256 left = d.remaining;
        if (amount > left) revert ExceedsRemaining(index, amount, left);

        claimed[index][holder] = true;
        d.remaining = left - amount;
        committed -= amount;

        _pay(holder, amount);

        emit Claimed(index, holder);
    }

    // --------------------------------------------------------------- sweep

    /// @notice Return an expired coupon's residue to the issuer. Permissionless.
    /// @dev Permissionless following `declareDefault` and `finalize`: the
    ///      destination is fixed at construction, so opening the call gives away
    ///      nothing and closing it would make the issuer the only party who can
    ///      end a coupon's life.
    function sweep(uint256 index) external returns (uint256 amount) {
        Declaration storage d = _declared[index];
        if (d.declaredAt == 0) revert NotDeclared(index);
        if (d.swept) revert AlreadySwept(index);
        uint64 closesAt = d.declaredAt + claimWindow;
        if (block.timestamp < closesAt) revert ClaimWindowOpen(closesAt);

        amount = d.remaining;
        d.remaining = 0;
        d.swept = true;
        committed -= amount;

        if (amount != 0) _pay(issuer, amount);
        emit Swept(index, amount);
    }

    /// @notice Return cash that was never committed to a declaration.
    /// @dev **The valve that stops a refused `declare` stranding a pool.** The
    ///      issuer funds this contract before declaring, and `declare` can
    ///      refuse afterwards, because a narrowed row 7 takes the ceiling out
    ///      from under it the same way one takes `PrimeOracle` dark. Without it,
    ///      the cash would sit here with no declaration to sweep against. It
    ///      also covers the ordinary accident of somebody sending the token to
    ///      this address.
    ///
    ///      It can never touch a live obligation: what it moves is the balance
    ///      above `committed`, which is exactly the quantity the invariant in
    ///      the class comment says is free.
    function sweepUncommitted() external returns (uint256 amount) {
        uint256 held = cash.balanceOf(address(this));
        uint256 owed = committed;
        if (held <= owed) revert NothingUncommitted();
        amount = held - owed;
        _pay(issuer, amount);
        emit UncommittedReturned(amount);
    }

    // ----------------------------------------------------------- the reads

    function declarationOf(uint256 index) external view returns (Declaration memory) {
        return _declared[index];
    }

    /// @notice What this coupon can still pay out.
    function remainingOf(uint256 index) external view returns (uint256) {
        return _declared[index].remaining;
    }

    /// @notice When claims on `index` stop. Zero if it was never declared.
    function claimsCloseAt(uint256 index) external view returns (uint64) {
        Declaration storage d = _declared[index];
        return d.declaredAt == 0 ? 0 : d.declaredAt + claimWindow;
    }

    /// @notice The leaf a claimant has to prove. Public and pure so the client,
    ///         `make vectors` and this contract cannot disagree about one.
    function leafOf(uint256 index, address holder, uint256 amount)
        external
        pure
        returns (bytes32)
    {
        return MerkleSet.leafOf(DOMAIN_LEAF, index, bytes32(uint256(uint160(holder))), amount);
    }

    /// @notice Whether a proof would be accepted, without sending anything.
    /// @dev A view for the reason `RepoVault.previewMark` is one: the
    ///      alternative for a client is to send a transaction to find out
    ///      whether it needed to. It discloses nothing: every input is already
    ///      in the caller's hand and the root is published.
    function wouldAccept(
        uint256 index,
        address holder,
        uint256 position,
        uint256 amount,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Declaration storage d = _declared[index];
        if (d.declaredAt == 0 || claimed[index][holder] || amount > d.remaining) return false;
        bytes32 leaf =
            MerkleSet.leafOf(DOMAIN_LEAF, index, bytes32(uint256(uint160(holder))), amount);
        return MerkleSet.verify(d.root, DOMAIN_NODE, leaf, position, d.holders, proof);
    }

    // ------------------------------------------------------------- payment

    /// @dev **The one place the custom fee can bite, and it refuses rather than
    ///      absorbs.** An HTS fractional fee is ordinarily deducted from the
    ///      amount transferred, so the recipient receives less and this
    ///      contract's balance falls by exactly `amount`. A token whose fee
    ///      schedule sets `netOfTransfers` charges the *sender* on top instead,
    ///      and then every payment costs this contract more than it committed.
    ///      The invariant in the class comment stops holding, and the shortfall
    ///      surfaces at the last claimant of the last coupon, which is the
    ///      furthest possible point from the fee schedule that caused it.
    ///
    ///      Measuring the balance either side turns that into a refusal on the
    ///      first claim, naming the fee. Two extra reads on a path that already
    ///      makes an external call, for a failure the funding check cannot see.
    function _pay(address to, uint256 amount) private {
        uint256 before = cash.balanceOf(address(this));
        if (!cash.transfer(to, amount)) revert TransferFailed(to, amount);
        uint256 left = cash.balanceOf(address(this));
        if (before - left > amount) revert FeeChargedOnTop(before - left, amount);
    }
}
