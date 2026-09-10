// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICompliance} from "../interfaces/ICompliance.sol";

/// @title ApprovalWindowCompliance
/// @notice A temporary ATS compliance seat for one owner-to-spender approval.
/// @dev ATS asks its compliance seat about `(owner, spender, 0)` before an
///      ERC-20 approval. A newly deployed vault cannot pass the address-bound
///      venue registry until its next credential epoch. This immutable seat
///      admits only that zero-value tuple. Positive-value transfers, other
///      owners, and other destinations remain refused while it is installed.
contract ApprovalWindowCompliance is ICompliance {
    error NotToken();

    address public immutable token;
    address public immutable owner;
    address public immutable spender;

    constructor(address token_, address owner_, address spender_) {
        token = token_;
        owner = owner_;
        spender = spender_;
    }

    function canTransfer(address from, address to, uint256 amount)
        external
        view
        returns (bool)
    {
        return from == owner && to == spender && amount == 0;
    }

    function transferred(address, address, uint256) external view {
        if (msg.sender != token) revert NotToken();
    }

    function created(address, uint256) external view {
        if (msg.sender != token) revert NotToken();
    }

    function destroyed(address, uint256) external view {
        if (msg.sender != token) revert NotToken();
    }
}
