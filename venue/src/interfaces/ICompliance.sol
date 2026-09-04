// SPDX-License-Identifier: Apache-2.0
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Source: packages/ats/contracts/contracts/facets/layer_1/ERC3643/ICompliance.sol
// Verbatim declarations, comments reduced. This is seam C and seam C-prime:
// the read side ATS STATICCALLs before a transfer, and the three write side
// notifications it CALLs after the balance has already moved.
//
// The census in docs/CALLSTACK.md is why this file now exists. Seam D alone
// does not see the controller rail, the maturity rail, or hold creation.
pragma solidity ^0.8.24;

interface ICompliance {
    /// @notice Post-state notification. A full CALL, after the balance write.
    function transferred(address _from, address _to, uint256 _amount) external;

    /// @notice Post-state notification for an issue.
    function created(address _to, uint256 _amount) external;

    /// @notice Post-state notification for a redemption.
    function destroyed(address _from, uint256 _amount) external;

    /// @notice Seam C. STATICCALL, pre-state. The only seam in the whole ATS
    ///         transfer path that receives the transfer amount.
    function canTransfer(address _from, address _to, uint256 _amount)
        external
        view
        returns (bool);
}
