// SPDX-License-Identifier: BUSL-1.1
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Source: packages/ats/contracts/contracts/facets/layer_1/externalPause/IExternalPause.sol
// Verbatim. This is seam A, the interface our pause implements so that ATS calls
// into it on every guarded operation.
//
// Seam A is the widest gate in the ATS surface. The census in docs/CALLSTACK.md
// measures 101 of 102 entry points reaching it, against 16 for seam D and 12 for
// seam C, and until `TransferPause` it was the one the venue left empty.
//
// The composition rule is OR and not AND: `PauseStorageWrapper.isExternallyPaused`
// returns on the first registered contract that answers true, so a second pause
// added later can only ever stop more. That is the opposite of seam B and seam D,
// which are ANDs, and it is why this seam cannot be occupied defensively.
pragma solidity ^0.8.24;

interface IExternalPause {
    /// @notice Whether this contract is currently pausing the token.
    /// @dev Called inside `PauseStorageWrapper.isExternallyPaused`, which is
    ///      reached from `checkUnpaused` on nearly every mutating entry point.
    ///      A revert here is a revert on the transfer path.
    function isPaused() external view returns (bool);
}
