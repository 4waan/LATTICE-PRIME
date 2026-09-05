// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IExternalKycList} from "../interfaces/IExternalKycList.sol";
import {IKyc} from "../interfaces/IKyc.sol";

/// @title ZkKycRegistry
/// @notice Seam D. ATS calls `getKycStatus` on every transfer.
/// @dev Never reverts, never unbounded gas: a revert here bricks the token.
///      Deny by default (`NOT_GRANTED == 0`). A grant in epoch `e` is dead in `e+1`.
contract ZkKycRegistry is IExternalKycList {
    // ------------------------------------------------------------- storage

    /// @dev Epoch of the grant, plus one. Zero means never granted, which is how
    ///      the default denial is the zero value rather than a branch.
    mapping(address => uint64) private _grantEpochPlusOne;

    /// @dev Nullifier use counter, packed as `epoch << 16 | count`. Read time
    ///      epoch comparison again: a counter stamped with a past epoch reads as
    ///      zero without anyone clearing it.
    mapping(bytes32 => uint256) private _nullifierUse;

    /// @notice Registrations per nullifier per epoch (sybil bound). Relay reads this first.
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
    /// @dev Never reverts. A revert here bricks the token (ATS ANDs every list).
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

    /// @dev Total: before `epochZero` returns 0 (reachable from `getKycStatus`).
    function _epochAt(uint256 ts) internal view returns (uint64) {
        if (ts < epochZero) return 0;
        return uint64((ts - epochZero) / epochLength);
    }

    // ------------------------------------------------------- the write side

    /// @notice Called by `RegistrationGate` after `passes == 1` and a valid proof.
    /// @dev Counter lives here so a gate swap cannot split the sybil bound from the grant.
    function grant(address account, bytes32 nullifier) external {
        if (msg.sender != gate) revert NotGate();
        uint64 e = _epochAt(block.timestamp);

        uint16 uses = _usesIn(nullifier, e);
        if (uses >= MAX_USES_PER_EPOCH) revert NullifierExhausted(nullifier, uses);
        _nullifierUse[nullifier] = (uint256(e) << 16) | uint256(uses + 1);

        _grantEpochPlusOne[account] = e + 1;
        emit Granted(account, e, nullifier);
    }

    /// @notice Uses of `nullifier` this epoch. Public so the relay can refuse before it pays.
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

    /// @notice Propose a new gate. Effective next epoch.
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
