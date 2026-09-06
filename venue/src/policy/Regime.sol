// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title Regime
/// @notice Governed disclosure policy. Proxies parameters, never code.
/// @dev `ideal` and `mandate` are immutable: a wider waiver or a narrower
///      obligation is a deployment. Supervisor may narrow (immediate, down) and
///      raise the floor (immediate, up). Operator moves inside the band at the
///      next epoch. Invariant: `floor <= current <= ceiling()`.
contract Regime {
    /// @notice Granted waiver. Effective ceiling is `meet(ideal, narrowed)`.
    uint32 public immutable ideal;

    /// @notice Supervisor restriction. Initially TOP.
    uint32 public narrowed;

    /// @notice Pending lift of `narrowed`, at `relaxEpoch`. Narrow now, widen later.
    uint32 public relaxTo;
    uint64 public relaxEpoch;

    /// @notice Granted obligation. A narrower mandate is a new deployment.
    uint32 public immutable mandate;

    /// @notice Obligation in force. Raise now, lower later. Bounded by `mandate`.
    uint32 public floor;

    /// @notice A lowering of the floor, and the epoch it lands at.
    uint32 public lowerTo;
    uint64 public lowerEpoch;

    /// @notice The configuration in force.
    uint32 public current;

    /// @notice The configuration that lands at `pendingEpoch`.
    uint32 public pending;
    uint64 public pendingEpoch;

    /// @notice Liquidity class, published not proved. MiFIR thresholds depend on it.
    uint16 public liquidityClass;
    uint16 public pendingLiquidityClass;

    /// @notice Set once after deploy (`VolumeCap` is the supervisor; construction cycle).
    address public supervisor;
    address public immutable deployer;
    address public immutable operator;
    IEpochClock public immutable clock;

    event Proposed(
        uint32 indexed point, uint16 liquidityClass, uint64 effectiveEpoch, bytes32 rationale
    );
    event Adopted(uint32 indexed point, uint16 liquidityClass, uint64 epoch);
    event Narrowed(uint32 indexed to, uint32 effective, bytes32 rationale);
    event RelaxProposed(uint32 indexed to, uint64 effectiveEpoch, bytes32 rationale);
    event Relaxed(uint32 indexed to, uint32 effective, uint64 epoch);
    event Clamped(uint32 from, uint32 to);
    event SupervisorBootstrapped(address indexed supervisor);
    /// @dev `Clamped` is a falling ceiling; `Raised` is a rising floor. Keep them distinct.
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
    /// @dev Ceiling forbids cells the floor requires.
    error Unsatisfiable(uint32 ceiling_, uint32 floor_, uint32 shortfall);
    error WouldLowerFloor(uint32 from, uint32 to);
    error WouldRaiseFloor(uint32 from, uint32 to);
    error BelowMandate(uint32 to, uint32 shortfall);

    /// @param mandate_ `BOTTOM` means no published obligation. Article 5 only raises it.
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
        // A grant that forbids what it compels is refused here, not later.
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

    /// @notice Appoint the supervisor once, while vacant. Deployer only.
    function bootstrapSupervisor(address s) external {
        if (msg.sender != deployer) revert NotSupervisor();
        if (supervisor != address(0)) revert NotSupervisor();
        supervisor = s;
        emit SupervisorBootstrapped(s);
    }

    /// @notice Ceiling in force: `meet(ideal, narrowed)`.
    function ceiling() public view returns (uint32) {
        return L.meet(ideal, narrowed);
    }

    /// @notice The check every disclosing contract should ask before emitting.
    function permits(uint32 actual) external view returns (bool) {
        return L.permits(current, actual);
    }

    /// @notice Propose a configuration. Lands next epoch. Operator only.
    function propose(uint32 point, uint16 liquidityClass_, bytes32 rationale) external {
        if (msg.sender != operator) revert NotOperator();
        L.requireIdeal(point);
        uint32 c = ceiling();
        if (!L.permits(c, point)) revert OutsideIdeal(point, L.excess(c, point));
        uint32 f = floor;
        if (!L.permits(point, f)) revert Unsatisfiable(point, f, L.excess(point, f));

        pending = point;
        pendingLiquidityClass = liquidityClass_;
        pendingEpoch = clock.currentEpoch() + 1;
        emit Proposed(point, liquidityClass_, pendingEpoch, rationale);
    }

    /// @notice Adopt pending config. Permissionless. Clamps if the ceiling moved.
    function adopt() external {
        if (pendingEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < pendingEpoch) revert NotYetEffective(pendingEpoch, e);

        current = pending;
        liquidityClass = pendingLiquidityClass;
        pending = 0;
        pendingEpoch = 0;
        _reconcile();
        emit Adopted(current, liquidityClass, e);
    }

    /// @notice Restrict below the granted waiver. Immediate, down only.
    function narrow(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        if (!L.permits(narrowed, to)) revert WouldWiden(narrowed, to);
        uint32 c = L.meet(ideal, to);
        uint32 f = floor;
        if (!L.permits(c, f)) revert Unsatisfiable(c, f, L.excess(c, f));
        _setNarrowed(to);
        emit Narrowed(to, ceiling(), rationale);
    }

    /// @notice Propose lifting a restriction. Bounded by `ideal`, next epoch.
    function proposeRelax(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        if (!L.permits(ideal, to)) revert WouldExceedIdeal(to, L.excess(ideal, to));
        relaxTo = to;
        relaxEpoch = clock.currentEpoch() + 1;
        emit RelaxProposed(to, relaxEpoch, rationale);
    }

    /// @notice Apply a proposed lift. Permissionless. Does not restore `current`.
    function adoptRelax() external {
        if (relaxEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < relaxEpoch) revert NotYetEffective(relaxEpoch, e);
        _setNarrowed(relaxTo);
        relaxTo = 0;
        relaxEpoch = 0;
        emit Relaxed(narrowed, ceiling(), e);
    }

    /// @notice Raise the obligation. Immediate, up only. Article 5's sign.
    /// @dev Bounded by `ceiling()`, not `ideal`. Retires any scheduled lowering.
    function raiseFloor(uint32 to, bytes32 rationale) external {
        if (msg.sender != supervisor) revert NotSupervisor();
        L.requireIdeal(to);
        uint32 f = floor;
        if (!L.permits(to, f)) revert WouldLowerFloor(f, to);
        uint32 c = ceiling();
        if (!L.permits(c, to)) revert Unsatisfiable(c, to, L.excess(c, to));

        lowerTo = 0;
        lowerEpoch = 0;

        _setFloor(to);
        emit FloorRaised(to, current, rationale);
    }

    /// @notice Propose returning the floor toward `mandate`. Next epoch.
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

    /// @notice Apply a proposed floor lowering. Permissionless. Does not move `current`.
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

    /// @dev Single writer for `narrowed`. Every ceiling write re-establishes
    ///      `current <= ceiling()`. Permissionless `adoptRelax` lifts rather than
    ///      reverts if a later floor has overtaken the scheduled restriction.
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

    function _setFloor(uint32 to) private {
        floor = to;
        _reconcile();
    }

    /// @dev `floor <= current <= ceiling()`. Separate events so a clamp is not a raise.
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
