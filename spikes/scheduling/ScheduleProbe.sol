// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0 <0.9.0;

/**
 * @notice Spike 4: can a contract schedule a transaction and let it fire, with
 *         no off-chain keeper anywhere in the loop.
 * @dev a design decision chose native scheduling over a keeper bot on the grounds that a
 *      keeper is off-chain infrastructure that has to be running for the system
 *      to be correct. That decision was recorded as settled "pending spike 4",
 *      which is to say it rested on a path nobody had executed.
 *
 *      Reconnaissance found HIP-1215's `hasScheduleCapacity` answering at
 *      `0x16b` with data where a garbage selector answers empty, and returning
 *      false for a past expiry and true for a future one. That is enough to
 *      know the selector is real. It is not enough to know a scheduled call
 *      fires, which is what this measures.
 */
interface IHederaScheduleService {
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external returns (bool);
}

contract ScheduleProbe {
    address private constant HSS = address(0x16b);

    uint256 public counter;
    uint256 public firedAt;
    address public lastCaller;

    /// @dev The scheduled call pays its own fee from this contract's balance.
    receive() external payable {}

    /// @dev The target. Deliberately trivial: the question is whether it runs at
    ///      all, so anything that could fail for its own reasons is noise.
    function bump() external {
        counter += 1;
        firedAt = block.timestamp;
        lastCaller = msg.sender;
    }

    function scheduleBump(
        uint256 delaySeconds,
        uint256 gasLimit
    ) external returns (int64 responseCode, address scheduleAddress) {
        return
            IHederaScheduleService(HSS).scheduleCall(
                address(this),
                block.timestamp + delaySeconds,
                gasLimit,
                0,
                abi.encodeWithSelector(this.bump.selector)
            );
    }

    function capacity(uint256 expirySecond, uint256 gasLimit) external returns (bool) {
        return IHederaScheduleService(HSS).hasScheduleCapacity(expirySecond, gasLimit);
    }
}
