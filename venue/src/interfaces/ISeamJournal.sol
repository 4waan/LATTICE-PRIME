// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title ISeamJournal
/// @notice What the journal records, and what it is allowed to say about it.
///         The seam C and C-prime entry points themselves are `ICompliance`.
interface ISeamJournal {
    /// @notice Why `explain` said no. `canTransfer` is `view` and answers with a
    ///         bool, so this is the only channel a reason travels on.
    enum Reason {
        OK,
        RECIPIENT_NOT_GRANTED,
        SENDER_NOT_GRANTED
    }

    /// @notice One epoch of activity. The supervisor channel: exact figures are
    ///         read from here and never from a log.
    struct EpochRecord {
        uint128 grossIn;
        uint128 grossOut;
        uint64 transfers;
        uint64 issues;
        uint64 redemptions;
        uint64 unverifiedArrivals;
    }

    /// @notice A transfer arrived at an address holding no live seam D grant.
    /// @param magnitude The amount's order of magnitude, base ten, never the
    ///        figure. An exact disclosure costs `domainBits` and a well formed
    ///        row has `budgetBits < domainBits`, so an event carrying one could
    ///        never fire; `testFuzz_aWellFormedBudgetCanNeverAffordAnExactDisclosure`
    ///        pins that.
    event UnverifiedArrival(address indexed to, uint8 magnitude, uint64 indexed epoch);

    /// @notice The same fact with the magnitude withheld, when the ceiling
    ///         affords a predicate and nothing more.
    event UnverifiedArrivalWithheld(address indexed to, uint64 indexed epoch);

    /// @notice A closed epoch, at the coarsest granularity the ceiling allows.
    event EpochDisclosed(uint64 indexed epoch, uint8 granularity, uint256 figure);

    error NotToken();
    error ZeroEpochLength();
    error BucketBitsTooSmall(uint16 given, uint16 required);

    /// @notice `canTransfer` with its reason. Off the ATS path; a client calls
    ///         it to learn why a simulation failed.
    function explain(address from, address to, uint256 amount)
        external
        view
        returns (bool ok, Reason reason);

    /// @notice Publish a closed epoch. Permissionless, so the timing of a
    ///         disclosure is not itself a discretionary signal.
    function disclose(uint64 epoch) external;

    function epochRecord(uint64 epoch) external view returns (EpochRecord memory);

    function spentBits(uint64 epoch) external view returns (uint32);

    function currentEpoch() external view returns (uint64);
}
