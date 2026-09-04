// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";

interface IEpochClock {
    function currentEpoch() external view returns (uint64);
}

/// @title Regime
/// @notice The governed disclosure policy, and the one contract in this repo
///         whose job is to say **no** to its own operator.
///
/// ## The trap this contract exists to avoid
///
/// "Proxy layer" on the EVM ordinarily means `delegatecall` upgradeability: the
/// code behind an address is replaceable. That is exactly the wrong construction
/// here, and it is wrong for a reason that has nothing to do with security.
///
/// `the study plan` D11c states the single sentence that separates this venue from
/// any permissioned venue that writes its own rules:
///
/// > The regulator defines the ideal. Governance moves within it. The circuit
/// > proves you stayed inside it.
///
/// That sentence is true of MiFID II: a national competent authority grants a
/// waiver, the venue configures within it, and **a venue cannot grant itself a
/// waiver**. A code proxy hands the venue the ability to rewrite the check that
/// bounds it, which is precisely the power the sentence claims we do not have.
/// An upgradeable venue has no ceiling it does not set.
///
/// > **So this proxies parameters and never code.** The ideal is `immutable`.
/// > Raising it is not a transaction, it is a deployment, which is the correct
/// > shape: a wider waiver is a new grant, not a configuration change.
///
/// ## Three principals, because the regulation has three
///
/// | | may | when | direction |
/// |---|---|---|---|
/// | deployment | fix the ideal and the mandate | once | sets both bounds |
/// | `supervisor` | narrow the ideal | immediately | **down only** |
/// | `supervisor` | raise the mandate | immediately | **up only** |
/// | `operator` | choose a point between them | next epoch | anywhere inside |
///
/// The asymmetry is the whole design. `supervisor` narrowing is immediate
/// because narrowing is always safe: the safe set is downward closed (D11c), so
/// every policy below a safe policy is safe, and a suspension that has to wait
/// for an epoch boundary is not a suspension. `operator` widening waits for the
/// boundary because BUILD-PLAN 7.4 Rule 2 and an invariant say governance lands on
/// boundaries, and the reason is disclosure rather than safety: a threshold that
/// moves on demand is itself an observation that a large order arrived.
///
/// ## What is enforced here that was previously written down
///
/// `docs/who-gets-privacy.md` DP-02 records that D11c establishes every reachable
/// configuration is **safe**, and that safety is a property of joins which says
/// nothing about neutrality, and that the containment claim itself is `[DOC]`.
/// One `leq`, 42 gas measured, moves the containment half from `[DOC]` to
/// enforced. It does not touch the neutrality half, which is not a property a
/// contract can hold, and DP-02's stated limit still stands unchanged.
contract Regime {
    /// @notice The waiver as granted. The venue may never exceed this.
    /// @dev Immutable by construction and not by discipline. `supervisor` holds a
    ///      separate narrowing that is stored, so the effective ceiling is
    ///      `meet(ideal, narrowed)` and is only ever lower than this.
    uint32 public immutable ideal;

    /// @notice The supervisor's standing restriction, initially TOP (no effect).
    uint32 public narrowed;

    /// @notice A restriction being lifted, and the epoch it lifts at.
    /// @dev Article 5's cap suspends the waiver for a period and then restores
    ///      it. A restriction that could only ever tighten would not be that
    ///      mechanism, it would be a one-way ratchet, so lifting has to exist.
    ///      The rule that keeps it honest is directional and is the same rule
    ///      the operator lives under:
    ///
    ///      > **Narrowing is immediate. Widening waits for a boundary. The ideal
    ///      > binds both.**
    ///
    ///      Narrowing immediately is safe because the safe set is downward
    ///      closed. Widening is the direction that leaks, so it lands under Rule
    ///      2 like every other governance action, and `ideal` bounds it whatever
    ///      the supervisor intends.
    uint32 public relaxTo;
    uint64 public relaxEpoch;

    // ------------------------------------------------------------ the floor
    //
    // Everything above this line is a **ceiling**. `permits(ceiling, actual)`
    // asks whether `actual` discloses at most as much as the policy allows, and
    // `L.point(G_EXACT, T_PRE) == L.TOP` puts full transparency at the top of
    // the lattice, which is the comparison that carried the DOGE framing and is
    // correct. A transparency obligation is the *other* comparison. MiFIR does
    // not say a venue may publish at most this much, it says **at least**, and a
    // waiver lowers that minimum rather than raising a maximum.
    //
    // `the design notes` a design decision records what that cost the first version.
    // Article 5's suspension was built as `narrow`, which moves the ceiling
    // *down*. A lower ceiling forbids disclosure and cannot compel it, so the
    // cap fired, the ceiling moved, and the live `current` sat inside the new
    // ceiling and never had to move at all. The venue kept trading dark.
    //
    // What a contract can hold here is narrower than the obligation itself. An
    // obligation runs over a row and a window, and a predicate emitted now can
    // be legitimately followed by the exact publication later, so it is not a
    // predicate on any one event and nothing below checks one. **The enforceable
    // part is that the floor bounds the ceiling**, which is an invariant: a
    // configuration that forbids what the venue must publish is un-adoptable,
    // and a live configuration is clamped **up** when the floor rises. That does
    // not guarantee the venue emits. It guarantees the venue cannot be
    // configured to be unable to, which is the half a contract can hold, and the
    // half that is worth having is exactly the half `narrow` did not hold.

    /// @notice The obligation as granted. The floor's counterpart to `ideal`.
    /// @dev Immutable for the reason `ideal` is immutable, read in the mirror.
    ///      `ideal` is immutable because a venue cannot grant itself a wider
    ///      waiver; `mandate` is immutable because a supervisor cannot waive an
    ///      obligation the grant fixed. A *narrower* obligation is a new grant
    ///      and therefore a deployment, not a transaction.
    uint32 public immutable mandate;

    /// @notice The obligation in force, initially `mandate`.
    /// @dev The asymmetry is the ceiling's, mirrored, for the mirrored reason:
    ///
    ///      > **Raising is immediate. Lowering waits for a boundary. The mandate
    ///      > binds both.**
    ///
    ///      Raising is immediate because compelling disclosure is the safe
    ///      direction here, and a suspension that waits for an epoch boundary is
    ///      not a suspension. Lowering restores a waiver, which is the direction
    ///      that buys secrecy, so it lands under Rule 2 like every other
    ///      widening.
    uint32 public floor;

    /// @notice A lowering of the floor, and the epoch it lands at.
    uint32 public lowerTo;
    uint64 public lowerEpoch;

    /// @notice The configuration in force.
    uint32 public current;

    /// @notice The configuration that lands at `pendingEpoch`.
    uint32 public pending;
    uint64 public pendingEpoch;

    /// @notice the marketplace study: the regulator's threshold is a function of `(size,
    ///         liquidity)` with three breakpoints, not of size alone. The class
    ///         is a governed parameter and it is **published rather than
    ///         proved**, which is D11e's own scope ruling stated as a field.
    uint16 public liquidityClass;
    uint16 public pendingLiquidityClass;

    /// @notice Set once, after deployment. **Not** immutable, and the reason is
    ///         a deployment cycle rather than a desire for flexibility.
    /// @dev `VolumeCap` takes a `Regime` in its constructor and is meant to *be*
    ///      the supervisor, so each needs the other's address first. The same
    ///      cycle exists between `ZkKycRegistry` and `RegistrationGate`, and this
    ///      is that file's `bootstrapGate` answer applied unchanged: one
    ///      unconditional write, visibly single use, deployer only, and after it
    ///      the role is fixed for the life of the contract. Writing it as a
    ///      general setter would have handed the operator a way to appoint its
    ///      own supervisor, which is the failure this whole contract is against.
    address public supervisor;
    address public immutable deployer;
    address public immutable operator;
    IEpochClock public immutable clock;

    /// @dev Every proposal carries a commitment to its written justification.
    ///      `who-gets-privacy.md` DP-01 asks for "a published constant with its
    ///      derivation" and DP-02 for "published rather than proved". A rationale
    ///      hash is what makes those dispositions checkable after the fact: the
    ///      operator cannot later claim a different reason than the one committed
    ///      to at proposal time.
    event Proposed(uint32 indexed point, uint16 liquidityClass, uint64 effectiveEpoch, bytes32 rationale);
    event Adopted(uint32 indexed point, uint16 liquidityClass, uint64 epoch);
    event Narrowed(uint32 indexed to, uint32 effective, bytes32 rationale);
    event RelaxProposed(uint32 indexed to, uint64 effectiveEpoch, bytes32 rationale);
    event Relaxed(uint32 indexed to, uint32 effective, uint64 epoch);
    event Clamped(uint32 from, uint32 to);
    event SupervisorBootstrapped(address indexed supervisor);

    /// @dev The upward clamp. `Clamped` is the live configuration falling to a
    ///      lowered ceiling; this is it rising to a raised floor. Two events and
    ///      not one, because an observer who cannot tell the directions apart
    ///      cannot tell a suspension from a restriction, which is the confusion
    ///      a design decision is about.
    event Raised(uint32 from, uint32 to);
    event FloorRaised(uint32 indexed to, uint32 current, bytes32 rationale);
    event FloorLowerProposed(uint32 indexed to, uint64 effectiveEpoch, bytes32 rationale);
    event FloorLowered(uint32 indexed to, uint32 current, uint64 epoch);
    event NarrowingLifted(uint32 from, uint32 to);

    error NotSupervisor();
    error NotOperator();
    error OutsideIdeal(uint32 proposed, uint32 excess);
    error NotYetEffective(uint64 want, uint64 have);
    error NothingPending();
    error WouldWiden(uint32 from, uint32 to);
    error WouldExceedIdeal(uint32 to, uint32 excess);

    /// @notice an invariant, in one error. The named cells are the ones the ceiling
    ///         forbids and the floor requires, so a violation says which
    ///         disclosures the two instructions disagree about.
    error Unsatisfiable(uint32 ceiling_, uint32 floor_, uint32 shortfall);
    error WouldLowerFloor(uint32 from, uint32 to);
    error WouldRaiseFloor(uint32 from, uint32 to);
    error BelowMandate(uint32 to, uint32 shortfall);

    /// @param mandate_ The obligation as granted. `BOTTOM` is a venue under no
    ///        published transparency obligation at all, which is a legitimate
    ///        configuration and is what a fully waived instrument looks like.
    ///        Article 5 raises the floor above it; it never falls below.
    constructor(
        uint32 ideal_,
        uint32 mandate_,
        uint32 initial_,
        address supervisor_,
        address operator_,
        IEpochClock clock_
    ) {
        L.requireIdeal(ideal_);
        L.requireIdeal(mandate_);
        L.requireIdeal(initial_);
        if (!L.permits(ideal_, initial_)) {
            revert OutsideIdeal(initial_, L.excess(ideal_, initial_));
        }
        // A grant that forbids what the same grant compels is a contradiction on
        // its face, and the only honest place to refuse it is here. There is
        // nothing to protect from a wedge at deployment: state a coherent pair
        // or do not deploy.
        if (!L.permits(ideal_, mandate_)) {
            revert Unsatisfiable(ideal_, mandate_, L.excess(ideal_, mandate_));
        }
        if (!L.permits(initial_, mandate_)) {
            revert Unsatisfiable(initial_, mandate_, L.excess(initial_, mandate_));
        }
        ideal = ideal_;
        mandate = mandate_;
        floor = mandate_;
        narrowed = L.TOP;
        current = initial_;
        supervisor = supervisor_; // may be zero, then bootstrapped once
        deployer = msg.sender;
        operator = operator_;
        clock = clock_;
    }

    /// @notice Appoint the supervisor, once, if the constructor left it unset.
    /// @dev Mirrors `ZkKycRegistry.bootstrapGate`. Callable only by the deployer
    ///      and only while the role is vacant, so it cannot become a transfer.
    function bootstrapSupervisor(address s) external {
        if (msg.sender != deployer) revert NotSupervisor();
        if (supervisor != address(0)) revert NotSupervisor();
        supervisor = s;
        emit SupervisorBootstrapped(s);
    }

    // ------------------------------------------------------ the ceiling

    /// @notice The ceiling actually in force: the granted waiver, as restricted.
    /// @dev Meet of two ideals is an ideal, so this needs no validation.
    function ceiling() public view returns (uint32) {
        return L.meet(ideal, narrowed);
    }

    /// @notice The check every disclosing contract should ask before emitting.
    function permits(uint32 actual) external view returns (bool) {
        return L.permits(current, actual);
    }

    // ------------------------------------------------- the operator side

    /// @notice Propose a configuration. Lands at the next epoch boundary.
    /// @dev The two lines that carry the pitch. `requireIdeal` rejects an
    ///      incoherent policy, one that claims an observer may know an exact
    ///      value but not the bucket containing it. `permits` rejects a coherent
    ///      policy the venue was not granted. Neither is a governance vote; the
    ///      operator simply cannot express the state.
    function propose(uint32 point, uint16 liquidityClass_, bytes32 rationale) external {
        if (msg.sender != operator) revert NotOperator();
        L.requireIdeal(point);
        uint32 c = ceiling();
        if (!L.permits(c, point)) revert OutsideIdeal(point, L.excess(c, point));
        // an invariant at the operator's end. A configuration that forbids what the
        // venue is obliged to publish is un-adoptable, and the operator finds
        // that out when it proposes rather than an epoch later.
        uint32 f = floor;
        if (!L.permits(point, f)) revert Unsatisfiable(point, f, L.excess(point, f));

        pending = point;
        pendingLiquidityClass = liquidityClass_;
        pendingEpoch = clock.currentEpoch() + 1;
        emit Proposed(point, liquidityClass_, pendingEpoch, rationale);
    }

    /// @notice Adopt the pending configuration once its epoch has arrived.
    /// @dev Permissionless, following `ZkKycRegistry.adoptGate`. If only the
    ///      operator could adopt, the timing of adoption would be a second
    ///      discretionary signal and Rule 2 would buy nothing.
    ///
    ///      Re-checked against the ceiling at adoption, not only at proposal.
    ///      The supervisor may have narrowed in between, and a proposal that was
    ///      inside the ideal when made must not land outside the ideal in force.
    function adopt() external {
        if (pendingEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < pendingEpoch) revert NotYetEffective(pendingEpoch, e);

        // Do not revert. A stale proposal that a narrowing has overtaken is an
        // ordinary event, and reverting would let one narrowing wedge the
        // operator out of governance until someone noticed. `_reconcile` clamps
        // instead, in whichever direction moved: down to the meet with a ceiling
        // that fell, up to the join with a floor that rose.
        current = pending;
        liquidityClass = pendingLiquidityClass;
        pending = 0;
        pendingEpoch = 0;
        _reconcile();
        emit Adopted(current, liquidityClass, e);
    }

    // ----------------------------------------------- the supervisor side

    /// @notice Restrict the venue below its granted waiver. Immediate.
    /// @dev Down only, and enforced rather than trusted: the new restriction must
    ///      be permitted by the old one. A supervisor who could widen would be a
    ///      supervisor who could grant a waiver, and then the contract would be
    ///      claiming a separation it does not implement.
    ///
    ///      This is MiFIR Article 5's suspension in its general form, and it is
    ///      the mechanism `marketplace/EVIDENCE.md` the marketplace study says the coordinate
    ///      system cannot express. It still cannot. What it can express is the
    ///      **withdrawal**, which is the enforcement half of a quota.
    function narrow(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        if (!L.permits(narrowed, to)) revert WouldWiden(narrowed, to);
        // an invariant at the supervisor's end, and the reason it is a revert here and
        // a clamp inside `_setNarrowed`: this is a live caller with discretion,
        // who can reconcile its own two instructions and try again. Refusing it
        // outright is what makes a contradictory restriction *un-adoptable*
        // rather than quietly half-applied.
        uint32 c = L.meet(ideal, to);
        uint32 f = floor;
        if (!L.permits(c, f)) revert Unsatisfiable(c, f, L.excess(c, f));
        _setNarrowed(to);
        emit Narrowed(to, ceiling(), rationale);
    }

    /// @notice Propose lifting a restriction. Lands at the next epoch boundary.
    /// @dev Bounded by `ideal` and not by `narrowed`, because this is the call
    ///      that undoes a narrowing. `ideal` is the only thing in this contract
    ///      that binds it, which is the point: the supervisor restores a waiver
    ///      it granted and cannot grant a wider one.
    function proposeRelax(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        if (!L.permits(ideal, to)) revert WouldExceedIdeal(to, L.excess(ideal, to));
        relaxTo = to;
        relaxEpoch = clock.currentEpoch() + 1;
        emit RelaxProposed(to, relaxEpoch, rationale);
    }

    /// @notice Apply a proposed lift once its epoch has arrived. Permissionless.
    /// @dev Lifting the restriction does not restore `current`. The operator
    ///      proposes into the wider space through `propose` like any other
    ///      configuration change, so a restoration is two visible governance
    ///      actions rather than one silent one.
    function adoptRelax() external {
        if (relaxEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < relaxEpoch) revert NotYetEffective(relaxEpoch, e);
        _setNarrowed(relaxTo);
        relaxTo = 0;
        relaxEpoch = 0;
        emit Relaxed(narrowed, ceiling(), e);
    }

    // ------------------------------------------------ the supervisor's floor

    /// @notice Hold the venue to a wider obligation than the grant fixed.
    ///         Immediate, and this is Article 5's suspension in the right sign.
    /// @dev Up only, and enforced rather than trusted, exactly as `narrow` is
    ///      down only. A supervisor who could lower the floor by calling this
    ///      would be a supervisor who could waive an obligation in the same block
    ///      it was imposed, and Rule 2 exists to stop that.
    ///
    ///      Bounded by `ceiling()` and not by `ideal`, because the ceiling is
    ///      what is in force. A supervisor holding a standing narrowing that
    ///      forbids the disclosure it now wants to compel has issued two
    ///      contradictory instructions, and this contract's job is to refuse the
    ///      second rather than to guess which one was meant. The way out is
    ///      `proposeRelax`, which is the supervisor withdrawing its own
    ///      restriction, and it takes an epoch because widening always does.
    function raiseFloor(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        uint32 f = floor;
        if (!L.permits(to, f)) revert WouldLowerFloor(f, to);
        uint32 c = ceiling();
        if (!L.permits(c, to)) revert Unsatisfiable(c, to, L.excess(c, to));

        // A raise retires any scheduled lowering. The supervisor restating the
        // obligation is the supervisor withdrawing the reduction it had queued,
        // and a schedule left live would let a restoration land at the boundary
        // *after* the suspension that overtook it, which is the one sequence
        // that would make the whole mechanism decorative again.
        lowerTo = 0;
        lowerEpoch = 0;

        _setFloor(to);
        emit FloorRaised(to, current, rationale);
    }

    /// @notice Propose returning the obligation toward the grant. Boundary.
    /// @dev Bounded by `mandate` and not by `floor`, for the reason
    ///      `proposeRelax` is bounded by `ideal` and not by `narrowed`: this is
    ///      the call that undoes a raise, so the standing value cannot be what
    ///      binds it. `mandate` is the only thing in this contract that does,
    ///      which is the point. The supervisor restores a waiver it granted and
    ///      cannot grant a wider one.
    function proposeLowerFloor(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        uint32 f = floor;
        if (!L.permits(f, to)) revert WouldRaiseFloor(f, to);
        if (!L.permits(to, mandate)) revert BelowMandate(to, L.excess(to, mandate));
        lowerTo = to;
        lowerEpoch = clock.currentEpoch() + 1;
        emit FloorLowerProposed(to, lowerEpoch, rationale);
    }

    /// @notice Apply a proposed lowering once its epoch has arrived.
    ///         Permissionless, following `adopt` and `adoptRelax`.
    /// @dev Lowering the floor does not lower `current`. The operator moves back
    ///      into the reclaimed space through `propose` like any other
    ///      configuration change, so a restoration is two visible governance
    ///      actions rather than one silent one. That is `adoptRelax`'s rule and
    ///      it is the same rule for the same reason.
    ///
    ///      The meet is a belt. `raiseFloor` clears a pending lowering, so no
    ///      reachable sequence today lands one that would undo a raise; the meet
    ///      makes that a property of this line rather than of that one.
    function adoptLowerFloor() external {
        if (lowerEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < lowerEpoch) revert NotYetEffective(lowerEpoch, e);
        uint32 to = L.meet(floor, lowerTo);
        lowerTo = 0;
        lowerEpoch = 0;
        _setFloor(to);
        emit FloorLowered(floor, current, e);
    }

    // ----------------------------------------------------- the single writers

    /// @dev The single writer for `narrowed`, and the reason it is a function.
    ///      Found by `testFuzz_nothingReachableEverExceedsTheGrant`: the first
    ///      version clamped `current` inside `narrow` and not inside
    ///      `adoptRelax`, so a scheduled restriction that happened to be
    ///      *tighter* than the live configuration moved the ceiling underneath it
    ///      and left `current` outside. The invariant is not "narrowing clamps",
    ///      it is **every write to the ceiling re-establishes `current <=
    ///      ceiling()`**, and the way to hold an invariant like that is to have
    ///      one place that can break it.
    ///
    ///      The floor added a second thing this one place has to re-establish.
    ///      `narrow` refuses a restriction that would put the ceiling under the
    ///      obligation, so the path that arrives here already failing is
    ///      `adoptRelax`, which is permissionless and must not be wedgeable by a
    ///      scheduled restriction the floor has since overtaken. So lift rather
    ///      than revert: the join is the smallest restriction that is both what
    ///      was scheduled and what the obligation admits, and it is the exact
    ///      mirror of `adopt`'s meet.
    function _setNarrowed(uint32 to) private {
        uint32 f = floor;
        if (!L.permits(L.meet(ideal, to), f)) {
            uint32 lifted = L.join(to, f);
            emit NarrowingLifted(to, lifted);
            to = lifted;
        }
        narrowed = to;
        _reconcile();
    }

    /// @dev The single writer for `floor`, for the reason `_setNarrowed` is the
    ///      single writer for `narrowed`.
    function _setFloor(uint32 to) private {
        floor = to;
        _reconcile();
    }

    /// @dev **an invariant, and it is one line of arithmetic in each direction.**
    ///      `floor <= current <= ceiling()`, re-established after every write
    ///      that could break either half. Falling to a lowered ceiling and rising
    ///      to a raised floor are the same operation with the lattice turned
    ///      over, and the reason they are written out separately is that the
    ///      events must not be: an observer who sees `Clamped` where `Raised`
    ///      belongs reads a suspension as a restriction.
    ///
    ///      The join is safe against the ceiling because every writer maintains
    ///      `floor <= ceiling()` before calling here, so `meet(current, c)`
    ///      joined with `floor` is still under `c`.
    function _reconcile() private {
        uint32 x = current;

        uint32 c = ceiling();
        if (!L.permits(c, x)) {
            uint32 down = L.meet(x, c);
            emit Clamped(x, down);
            x = down;
        }

        uint32 f = floor;
        if (!L.permits(x, f)) {
            uint32 up = L.join(x, f);
            emit Raised(x, up);
            x = up;
        }

        if (x != current) current = x;
    }
}
