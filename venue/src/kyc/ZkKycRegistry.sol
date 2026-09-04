// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IExternalKycList} from "../interfaces/IExternalKycList.sol";
import {IKyc} from "../interfaces/IKyc.sol";

/// @title ZkKycRegistry
/// @notice Seam D. The contract ATS calls on every transfer.
///
/// ## The contract this file has with the rest of the system
///
/// `getKycStatus` sits on the ATS transfer critical path and is `view`. It
/// therefore cannot verify a proof, cannot write a nullifier and cannot emit an
/// event. All of that happens in a prior transaction, in `RegistrationGate`, and
/// this contract only reads the result. That is the two transaction structure
/// every flow in the design accounts for.
///
/// Three invariants live here and nowhere else.
///
/// **an invariant, this function never reverts and never consumes unbounded gas.** A
/// revert here does not fail one transfer, it bricks the token, because ATS
/// aggregates every registered external list with an unconditional AND and a
/// reverting member takes the whole conjunction down. So there are no external
/// calls, no loops, no unchecked subtraction on a value that can go negative,
/// and no `require`. Every path returns.
///
/// **an invariant, no path grants eligibility from an empty or unset state.** ATS fails
/// **open** when its external list is empty, which is the one place the
/// platform's default runs against this design. The defence cannot be "do not
/// forget to register", it has to be that the registry itself denies by default.
/// `KycStatus.NOT_GRANTED` is enum value zero, so an address this contract has
/// never seen is denied by the zero value rather than by a branch.
///
/// **an invariant, a grant in epoch `e` grants nothing in epoch `e+1`.** The comparison
/// is at read time. Writing the expiry at write time would make the registry
/// unreadable across a rollover, because every stored grant would have to be
/// rewritten by someone at the boundary and nobody is on the hook to do it.
contract ZkKycRegistry is IExternalKycList {
    // ------------------------------------------------------------- storage

    /// @dev Epoch of the grant, plus one. Zero means never granted, which is how
    ///      the default denial is the zero value rather than a branch.
    mapping(address => uint64) private _grantEpochPlusOne;

    /// @dev Nullifier use counter, packed as `epoch << 16 | count`. Read time
    ///      epoch comparison again: a counter stamped with a past epoch reads as
    ///      zero without anyone clearing it.
    mapping(bytes32 => uint256) private _nullifierUse;

    /// @notice K in an invariant. Registrations per nullifier per epoch.
    /// @dev Provisional at 5, from a design decision. It is the sybil bound, and it is the
    ///      number the relay's cheap refusal in an invariant reads before it pays.
    uint16 public constant MAX_USES_PER_EPOCH = 5;

    uint64 public immutable epochZero;
    uint64 public immutable epochLength;

    /// @notice The only address allowed to write. `RegistrationGate`.
    address public gate;
    /// @notice A pending gate change, and the epoch it becomes effective.
    address public pendingGate;
    uint64 public pendingGateEpoch;

    address public immutable admin;

    // -------------------------------------------------------------- events

    event Granted(address indexed account, uint64 indexed epoch, bytes32 nullifier);
    event GateProposed(address indexed next, uint64 indexed effectiveEpoch);
    event GateAdopted(address indexed next, uint64 indexed epoch);

    // -------------------------------------------------------------- errors

    error NotGate();
    error NotAdmin();
    error ZeroEpochLength();
    error NullifierExhausted(bytes32 nullifier, uint16 uses);
    error NotYetEffective(uint64 effectiveEpoch, uint64 current);

    // --------------------------------------------------------- constructor

    constructor(address admin_, uint64 epochZero_, uint64 epochLength_) {
        if (epochLength_ == 0) revert ZeroEpochLength();
        admin = admin_;
        epochZero = epochZero_;
        epochLength = epochLength_;
    }

    // ------------------------------------------------------- the seam call

    /// @inheritdoc IExternalKycList
    /// @dev an invariant. Read the class comment before touching this function. It has
    ///      no revert path by construction and that is a property, not a habit.
    function getKycStatus(address account) external view returns (IKyc.KycStatus) {
        uint64 stored = _grantEpochPlusOne[account];
        if (stored == 0) return IKyc.KycStatus.NOT_GRANTED;
        if (stored - 1 != _epochAt(block.timestamp)) return IKyc.KycStatus.NOT_GRANTED;
        return IKyc.KycStatus.GRANTED;
    }

    // ------------------------------------------------------------- epochs

    function currentEpoch() external view returns (uint64) {
        return _epochAt(block.timestamp);
    }

    /// @dev Total. Before `epochZero` the epoch is zero rather than a revert,
    ///      because this is reachable from `getKycStatus` and an invariant admits no
    ///      revert. A grant can never be read as live before epoch zero anyway:
    ///      nothing can have been written yet.
    function _epochAt(uint256 ts) internal view returns (uint64) {
        if (ts < epochZero) return 0;
        return uint64((ts - epochZero) / epochLength);
    }

    // ------------------------------------------------------- the write side

    /// @notice Called by `RegistrationGate` after, and only after, a proof has
    ///         verified and its `passes` output has been checked.
    /// @dev The counter is incremented here rather than in the gate so that the
    ///      state an invariant bounds and the state an invariant reads live in one contract
    ///      and cannot drift apart across a gate swap.
    function grant(address account, bytes32 nullifier) external {
        if (msg.sender != gate) revert NotGate();
        uint64 e = _epochAt(block.timestamp);

        uint16 uses = _usesIn(nullifier, e);
        if (uses >= MAX_USES_PER_EPOCH) revert NullifierExhausted(nullifier, uses);
        _nullifierUse[nullifier] = (uint256(e) << 16) | uint256(uses + 1);

        _grantEpochPlusOne[account] = e + 1;
        emit Granted(account, e, nullifier);
    }

    /// @notice Uses of `nullifier` in the current epoch.
    /// @dev Public because an invariant requires the relay to be able to read the sybil
    ///      counter *before* it pays for a sponsored registration. Proof validity
    ///      does not carry that bound, so the relay has to check it itself.
    function usesThisEpoch(bytes32 nullifier) external view returns (uint16) {
        return _usesIn(nullifier, _epochAt(block.timestamp));
    }

    function _usesIn(bytes32 nullifier, uint64 e) internal view returns (uint16) {
        uint256 packed = _nullifierUse[nullifier];
        if (packed >> 16 != uint256(e)) return 0;
        // The low sixteen bits are the count by construction: every write in
        // `grant` stores `uses + 1` bounded by MAX_USES_PER_EPOCH, which is 5.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(packed);
    }

    // -------------------------------------------- governance, an invariant / Rule 2

    /// @notice Propose a new gate. Takes effect at the next epoch boundary.
    /// @dev Governance rule: governance actions land only at epoch
    ///      boundaries. The reason is disclosure rather than safety. A gate that
    ///      can be swapped on demand makes the swap itself an observable event
    ///      correlated with whatever prompted it, and that observation is not in
    ///      any matrix cell. Deferring to a boundary puts it in row 10 with every
    ///      other governance action.
    function proposeGate(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingGate = next;
        pendingGateEpoch = _epochAt(block.timestamp) + 1;
        emit GateProposed(next, pendingGateEpoch);
    }

    /// @notice Adopt the proposed gate once its epoch has arrived.
    /// @dev Permissionless on purpose. If only the admin could adopt, the timing
    ///      of adoption would be a second discretionary signal and Rule 2 would
    ///      buy nothing.
    function adoptGate() external {
        uint64 e = _epochAt(block.timestamp);
        if (e < pendingGateEpoch || pendingGate == address(0)) {
            revert NotYetEffective(pendingGateEpoch, e);
        }
        gate = pendingGate;
        pendingGate = address(0);
        emit GateAdopted(gate, e);
    }

    /// @notice One time bootstrap, before any gate exists.
    /// @dev Separate from `proposeGate` so that the epoch delay is not something
    ///      the deploy script has to wait out, and so that the only unconditional
    ///      write to `gate` is visibly single use.
    function bootstrapGate(address first) external {
        if (msg.sender != admin) revert NotAdmin();
        if (gate != address(0)) revert NotAdmin();
        gate = first;
        emit GateAdopted(first, _epochAt(block.timestamp));
    }
}
