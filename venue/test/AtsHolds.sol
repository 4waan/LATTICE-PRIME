// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";

/// @notice ATS hold rules the repo book actually depends on.
/// @dev Lifted from `MatchingEngine.t.sol` so repo tests cannot pass a destination
///      or expiry that the live token would refuse. `MockHolds` used to record
///      calls and succeed; that hid the open/close mismatch.
///
///      Rules transcribed from ATS v8.0.0 `HoldStorageWrapper`:
///      - only the recorded escrow may execute or release
///      - execute destination must match `hold.to` unless `to == address(0)`
///      - execute requires the destination to remain identified and compliant
///      - execute and release refuse once `block.timestamp >= expiry`
///      - amount cannot exceed the remaining hold
///
///      `revertNextCreate` is the injected ATS failure the cash-leg tests use
///      to prove both legs roll back.
contract AtsHolds is IHoldByPartition {
    struct H {
        uint256 amount;
        uint256 expiry;
        address escrow;
        address to;
        address authorized;
        bool exists;
    }

    mapping(bytes32 => H) private _holds;
    mapping(bytes32 => uint256) private _held;
    mapping(bytes32 => uint256) private _free;
    mapping(address => mapping(address => uint256)) private _allowances;
    mapping(address => bool) private _recipientDenied;
    mapping(address => uint256) public delivered;

    uint256 public nextId = 1;
    uint256 public created;
    uint256 public executed;
    uint256 public released;
    address public lastExecutedTo;
    uint256 public lastExecutedAmount;
    address public lastHoldTo;
    uint256 public lastHoldExpiry;
    address public lastReleasedHolder;
    uint256 public lastReleasedAmount;
    bool public revertNextCreate;

    error InjectedHoldFailure();
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientFreeBalance(uint256 available, uint256 required);
    error RecipientNotEligible(address account);

    function _key(bytes32 p, address holder, uint256 id) private pure returns (bytes32) {
        return keccak256(abi.encode(p, holder, id));
    }

    function _holderKey(bytes32 p, address holder) private pure returns (bytes32) {
        return keccak256(abi.encode(p, holder));
    }

    function setRevertNextCreate(bool v) external {
        revertNextCreate = v;
    }

    function setRecipientEligible(address account, bool eligible) external {
        _recipientDenied[account] = !eligible;
    }

    function mint(bytes32 partition, address to, uint256 amount) external {
        _free[_holderKey(partition, to)] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function balanceOfByPartition(bytes32 partition, address tokenHolder)
        external
        view
        returns (uint256)
    {
        return _free[_holderKey(partition, tokenHolder)];
    }

    function createHoldByPartition(bytes32 partition, IHoldTypes.Hold calldata hold)
        external
        returns (bool, uint256)
    {
        return _create(partition, msg.sender, hold, false);
    }

    function createHoldFromByPartition(
        bytes32 partition,
        address from,
        IHoldTypes.Hold calldata hold,
        bytes calldata
    ) external returns (bool, uint256) {
        return _create(partition, from, hold, true);
    }

    function _create(
        bytes32 partition,
        address from,
        IHoldTypes.Hold calldata hold,
        bool authorized
    )
        private
        returns (bool, uint256)
    {
        if (revertNextCreate) {
            revertNextCreate = false;
            revert InjectedHoldFailure();
        }
        require(hold.amount != 0, "InvalidHoldAmount");
        require(hold.expirationTimestamp > block.timestamp, "WrongExpirationTimestamp");
        require(from != address(0) && hold.escrow != address(0), "ZeroAddress");
        if (authorized) {
            uint256 available = _allowances[from][msg.sender];
            if (available < hold.amount) {
                revert InsufficientAllowance(available, hold.amount);
            }
            _allowances[from][msg.sender] = available - hold.amount;
        }
        bytes32 holderKey = _holderKey(partition, from);
        uint256 free = _free[holderKey];
        if (free < hold.amount) revert InsufficientFreeBalance(free, hold.amount);
        _free[holderKey] = free - hold.amount;

        uint256 id = nextId++;
        _holds[_key(partition, from, id)] = H({
            amount: hold.amount,
            expiry: hold.expirationTimestamp,
            escrow: hold.escrow,
            to: hold.to,
            authorized: authorized ? msg.sender : address(0),
            exists: true
        });
        _held[holderKey] += hold.amount;
        created++;
        lastHoldTo = hold.to;
        lastHoldExpiry = hold.expirationTimestamp;
        return (true, id);
    }

    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool, bytes32) {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists, "no hold");
        require(h.escrow == msg.sender, "IsNotEscrow");
        require(h.to == address(0) || h.to == to, "InvalidDestinationAddress");
        require(block.timestamp < h.expiry, "HoldExpirationReached");
        if (_recipientDenied[to]) revert RecipientNotEligible(to);
        require(h.amount >= amount, "amount");
        h.amount -= amount;
        _held[_holderKey(id.partition, id.tokenHolder)] -= amount;
        _free[_holderKey(id.partition, to)] += amount;
        delivered[to] += amount;
        executed++;
        lastExecutedTo = to;
        lastExecutedAmount = amount;
        return (true, id.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata id, uint256 amount)
        external
        returns (bool)
    {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists && h.escrow == msg.sender, "release");
        require(block.timestamp < h.expiry, "HoldExpirationReached");
        require(h.amount >= amount, "amount");
        h.amount -= amount;
        bytes32 holderKey = _holderKey(id.partition, id.tokenHolder);
        _held[holderKey] -= amount;
        _free[holderKey] += amount;
        if (h.authorized != address(0)) {
            _allowances[id.tokenHolder][h.authorized] += amount;
        }
        released++;
        lastReleasedHolder = id.tokenHolder;
        lastReleasedAmount = amount;
        return true;
    }

    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata id)
        external
        view
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        return (h.amount, h.expiry, h.escrow, h.to, "", "", h.authorized == address(0) ? 0 : 1);
    }

    function getHeldAmountForByPartition(bytes32 partition, address tokenHolder)
        external
        view
        returns (uint256)
    {
        return _held[_holderKey(partition, tokenHolder)];
    }
}

/// @dev Name the old suites keep importing. Behaviour is now the ATS rules.
contract MockHolds is AtsHolds {}
