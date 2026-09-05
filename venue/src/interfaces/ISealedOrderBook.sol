// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice The slice of the book `AxeBoard` reads. Keeps the board off `MatchingEngine`.
interface ISealedOrderBook {
    function commitBond() external view returns (uint256);

    function commitments(bytes32 id)
        external
        view
        returns (
            address committer,
            uint64 committedAt,
            bool revealed,
            bool cancelled,
            uint256 bond
        );
}
