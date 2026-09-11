// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICashToken} from "../interfaces/ICashToken.sol";
import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {ISealedOrderBook} from "../interfaces/ISealedOrderBook.sol";
import {OrderBook} from "../market/OrderBook.sol";

/// @notice The unchanged MatchingEngine surface used by a session account.
interface ISessionEngine is ISealedOrderBook {
    function commit(bytes32 id) external payable;

    function reveal(
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 salt,
        uint256 backing
    ) external payable;

    function cancel(bytes32 id) external;
    function expire(bytes32 id) external;
    function withdraw() external;

    function commitmentOf(
        address committer,
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 salt
    ) external pure returns (bytes32);

    function revealDelay() external view returns (uint64);
    function revealWindow() external view returns (uint64);
    function roundLength() external view returns (uint64);
    function restRounds() external view returns (uint64);
    function genesis() external view returns (uint64);
    function security() external view returns (IHoldByPartition);
    function partition() external view returns (bytes32);
}

/// @notice Coupon claims already fix their recipient in the proved leaf.
interface ISessionCouponClaimer {
    function claim(
        uint256 index,
        address holder,
        uint256 position,
        uint256 amount,
        bytes32[] calldata proof
    ) external;
}

interface ISessionRecoveryRouter {
    function routeNative(uint256 commitment) external payable returns (uint256 root);
    function routeToken(address asset, uint256 amount, uint256 commitment)
        external
        returns (uint256 root);
}

/// @title SessionAccount
/// @notice Restricted, prefunded account for timed sealed orders.
/// @dev The account itself is the engine committer and ATS token holder. It has
///      no arbitrary execution, delegate call, upgrade, signer rotation, or
///      per-order storage. A new generation deploys a new account.
///
///      This build targets Cancun in `foundry.toml`, so the reentrancy lock uses
///      EIP-1153 transient storage. The lock adds no persistent account slot and
///      is cleared by the transaction frame, including on revert.
contract SessionAccount {
    uint64 public constant QUICKNET_GENESIS = 1_692_803_367;
    uint64 public constant QUICKNET_PERIOD = 3;
    bytes32 public constant QUICKNET_CHAIN_HASH =
        0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;
    uint64 public constant REVEAL_GUARD = 12 seconds;
    uint64 public constant RETRY_MARGIN = 60 seconds;

    bytes32 public constant AUTOMATION_DOMAIN =
        keccak256("hedera2026.session.automation-metadata.v1");

    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant NAME_HASH = keccak256("Hedera2026 SessionAccount");
    bytes32 public constant VERSION_HASH = keccak256("1");

    bytes32 public constant PLACE_TYPEHASH = keccak256(
        "PlaceSealed(uint256 chainId,address account,address engine,bytes32 commitment,"
        "bytes32 envelopeDigest,bytes32 quicknetChainHash,uint64 quicknetRound,"
        "uint64 generation,bytes32 feePolicyDigest)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256(
        "CancelSealed(uint256 chainId,address account,address engine,bytes32 commitment,"
        "bytes32 envelopeDigest,bytes32 quicknetChainHash,uint64 quicknetRound,"
        "uint64 generation,bytes32 feePolicyDigest)"
    );
    bytes32 public constant RECOVERY_TYPEHASH = keccak256(
        "RecoverToRouter(uint256 chainId,address account,address router,address asset,"
        "uint256 amount,uint256 noteCommitment,uint256 nonce,uint64 generation)"
    );

    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant REENTRANCY_SLOT =
        keccak256("hedera2026.session.transient-reentrancy.v1");

    address public immutable sessionSigner;
    address public immutable recoverySigner;
    ISessionEngine public immutable engine;
    IHoldByPartition public immutable security;
    bytes32 public immutable partition;
    ISessionRecoveryRouter public immutable router;
    bytes32 public immutable quicknetChainHash;
    uint64 public immutable generation;
    bytes32 public immutable feePolicyDigest;

    uint256 public immutable engineCommitBond;
    uint64 public immutable engineRevealDelay;
    uint64 public immutable engineRevealWindow;
    uint64 public immutable engineRoundLength;
    uint64 public immutable engineRestRounds;
    uint64 public immutable engineGenesis;

    /// @notice Replay protection for recovery only. Orders use permanent engine state.
    uint256 public recoveryNonce;

    error ZeroAddress();
    error RouterHasNoCode(address router);
    error WrongQuicknetChainHash(bytes32 provided);
    error SignersMustDiffer();
    error EngineSecurityMismatch(address configured, address engineSecurity);
    error EnginePartitionMismatch(bytes32 configured, bytes32 enginePartition);
    error EngineRevealWindowTooNarrow(uint64 window, uint64 required);
    error EngineRoundLengthIsZero();
    error InvalidQuicknetRound(uint64 round);
    error QuicknetTimestampOverflow(uint64 round);
    error ReleaseOutsideSafeWindow(uint64 releaseAt, uint256 earliest, uint256 latest);
    error TimedReleasePending(uint64 releaseAt);
    error InvalidSignatureLength(uint256 length);
    error InvalidSignatureV(uint8 v);
    error InvalidSignatureS(bytes32 s);
    error InvalidSigner(address recovered, address expected);
    error InsufficientNativeBalance(uint256 available, uint256 required);
    error CommitmentOwnerMismatch(bytes32 id, address found);
    error HoldCreationFailed();
    error ReentrantCall();
    error InvalidRecoveryNonce(uint256 got, uint256 expected);
    error ZeroAmount();
    error ZeroCommitment();
    error TokenRecoveryFailed(address asset);
    error InvalidCouponTarget(address target);

    constructor(
        address sessionSigner_,
        address recoverySigner_,
        ISessionEngine engine_,
        IHoldByPartition security_,
        bytes32 partition_,
        address payable router_,
        bytes32 quicknetChainHash_,
        uint64 generation_,
        bytes32 feePolicyDigest_
    ) payable {
        if (
            sessionSigner_ == address(0) || recoverySigner_ == address(0)
                || address(engine_) == address(0) || address(security_) == address(0)
                || router_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (sessionSigner_ == recoverySigner_) revert SignersMustDiffer();
        if (router_.code.length == 0) revert RouterHasNoCode(router_);
        if (quicknetChainHash_ != QUICKNET_CHAIN_HASH) {
            revert WrongQuicknetChainHash(quicknetChainHash_);
        }

        address engineSecurity = address(engine_.security());
        if (engineSecurity != address(security_)) {
            revert EngineSecurityMismatch(address(security_), engineSecurity);
        }
        bytes32 enginePartition_ = engine_.partition();
        if (enginePartition_ != partition_) {
            revert EnginePartitionMismatch(partition_, enginePartition_);
        }

        uint64 revealWindow_ = engine_.revealWindow();
        uint64 requiredWindow = REVEAL_GUARD + RETRY_MARGIN;
        if (revealWindow_ < requiredWindow) {
            revert EngineRevealWindowTooNarrow(revealWindow_, requiredWindow);
        }

        uint64 roundLength_ = engine_.roundLength();
        if (roundLength_ == 0) revert EngineRoundLengthIsZero();

        sessionSigner = sessionSigner_;
        recoverySigner = recoverySigner_;
        engine = engine_;
        security = security_;
        partition = partition_;
        router = ISessionRecoveryRouter(router_);
        quicknetChainHash = quicknetChainHash_;
        generation = generation_;
        feePolicyDigest = feePolicyDigest_;

        engineCommitBond = engine_.commitBond();
        engineRevealDelay = engine_.revealDelay();
        engineRevealWindow = revealWindow_;
        engineRoundLength = roundLength_;
        engineRestRounds = engine_.restRounds();
        engineGenesis = engine_.genesis();
    }

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 entered;
        assembly {
            entered := tload(slot)
        }
        if (entered != 0) revert ReentrantCall();
        assembly {
            tstore(slot, 1)
        }
        _;
        assembly {
            tstore(slot, 0)
        }
    }

    receive() external payable {}

    // ---------------------------------------------------------- authorization

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    function placeAuthorizationDigest(
        bytes32 commitment,
        bytes32 envelopeDigest,
        uint64 quicknetRound
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PLACE_TYPEHASH,
                block.chainid,
                address(this),
                address(engine),
                commitment,
                envelopeDigest,
                quicknetChainHash,
                quicknetRound,
                generation,
                feePolicyDigest
            )
        );
        return _typedDataHash(structHash);
    }

    function cancelAuthorizationDigest(
        bytes32 commitment,
        bytes32 envelopeDigest,
        uint64 quicknetRound
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CANCEL_TYPEHASH,
                block.chainid,
                address(this),
                address(engine),
                commitment,
                envelopeDigest,
                quicknetChainHash,
                quicknetRound,
                generation,
                feePolicyDigest
            )
        );
        return _typedDataHash(structHash);
    }

    function recoveryAuthorizationDigest(
        address asset,
        uint256 amount,
        uint256 noteCommitment,
        uint256 nonce
    )
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                RECOVERY_TYPEHASH,
                block.chainid,
                address(this),
                address(router),
                asset,
                amount,
                noteCommitment,
                nonce,
                generation
            )
        );
        return _typedDataHash(structHash);
    }

    function _typedDataHash(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash));
    }

    // --------------------------------------------------------- sealed orders

    /// @notice Place one signer-authorized commitment from this account.
    /// @dev Exact replay reaches the engine's permanent `AlreadyCommitted` state.
    function placeSealed(
        bytes32 commitment,
        bytes32 envelopeDigest,
        uint64 quicknetRound,
        bytes calldata signature
    ) external nonReentrant {
        _validatePlacementRound(quicknetRound);
        _requireSigner(
            sessionSigner,
            placeAuthorizationDigest(commitment, envelopeDigest, quicknetRound),
            signature
        );

        uint256 bond = engineCommitBond;
        uint256 balance = address(this).balance;
        if (balance < bond) revert InsufficientNativeBalance(balance, bond);
        engine.commit{value: bond}(commitment);
    }

    /// @notice Reveal a committed order after its pinned Quicknet release.
    /// @dev The decrypted preimage is the permissionless reveal capability. The
    ///      engine commitment owner is checked before funds or ATS state move.
    function revealAuthorized(
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 randomSalt,
        bytes32 envelopeDigest,
        uint64 quicknetRound
    ) external nonReentrant returns (bytes32 id) {
        uint64 releaseAt = quicknetReleaseTime(quicknetRound);
        if (block.timestamp < releaseAt) revert TimedReleasePending(releaseAt);

        bytes32 salt = engineSalt(envelopeDigest, quicknetRound, randomSalt);
        id = engine.commitmentOf(address(this), side, price, qty, salt);

        (address committer,,,,) = engine.commitments(id);
        if (committer != address(this)) revert CommitmentOwnerMismatch(id, committer);

        if (side == OrderBook.Side.BUY) {
            _revealBuy(price, qty, salt);
            return id;
        }
        _revealSell(price, qty, salt);
    }

    function _revealBuy(uint128 price, uint128 qty, bytes32 salt) private {
        uint256 escrow = uint256(price) * uint256(qty);
        uint256 balance = address(this).balance;
        if (balance < escrow) revert InsufficientNativeBalance(balance, escrow);
        engine.reveal{value: escrow}(OrderBook.Side.BUY, price, qty, salt, 0);
    }

    function _revealSell(uint128 price, uint128 qty, bytes32 salt) private {
        (bool success, uint256 holdId) = security.createHoldByPartition(
            partition,
            IHoldTypes.Hold({
                amount: uint256(qty),
                expirationTimestamp: sellHoldExpiry(),
                escrow: address(engine),
                to: address(0),
                data: ""
            })
        );
        if (!success || holdId == 0) revert HoldCreationFailed();
        engine.reveal(OrderBook.Side.SELL, price, qty, salt, holdId);
    }

    /// @notice Cancel only with a separately typed session authorization.
    function cancelAuthorized(
        bytes32 commitment,
        bytes32 envelopeDigest,
        uint64 quicknetRound,
        bytes calldata signature
    ) external nonReentrant {
        _requireSigner(
            sessionSigner,
            cancelAuthorizationDigest(commitment, envelopeDigest, quicknetRound),
            signature
        );
        engine.cancel(commitment);
    }

    /// @notice Retire any rested-out engine order. The engine call is permissionless.
    function expire(bytes32 id) external nonReentrant {
        engine.expire(id);
    }

    /// @notice Pull this account's accumulated proceeds and refunds from the engine.
    function sweepEngineCredit() external nonReentrant {
        engine.withdraw();
    }

    // ----------------------------------------------------- metadata and time

    function automationMetadata(bytes32 envelopeDigest, uint64 quicknetRound)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                AUTOMATION_DOMAIN,
                quicknetChainHash,
                address(this),
                generation,
                address(engine),
                envelopeDigest,
                quicknetRound,
                feePolicyDigest
            )
        );
    }

    function engineSalt(bytes32 envelopeDigest, uint64 quicknetRound, bytes32 randomSalt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(automationMetadata(envelopeDigest, quicknetRound), randomSalt)
        );
    }

    function commitmentFor(
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 randomSalt,
        bytes32 envelopeDigest,
        uint64 quicknetRound
    ) external view returns (bytes32) {
        return engine.commitmentOf(
            address(this),
            side,
            price,
            qty,
            engineSalt(envelopeDigest, quicknetRound, randomSalt)
        );
    }

    function quicknetReleaseTime(uint64 quicknetRound) public pure returns (uint64) {
        if (quicknetRound == 0) revert InvalidQuicknetRound(quicknetRound);
        uint256 releaseAt =
            uint256(QUICKNET_GENESIS) + (uint256(quicknetRound) - 1) * QUICKNET_PERIOD;
        if (releaseAt > type(uint64).max) revert QuicknetTimestampOverflow(quicknetRound);
        // The bound immediately above proves the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(releaseAt);
    }

    /// @notice Expiry used for a sell hold created at the current engine round.
    /// @dev The margin keeps the hold alive through the last resting-round close.
    function sellHoldExpiry() public view returns (uint256) {
        uint256 current;
        if (block.timestamp > engineGenesis) {
            current = (block.timestamp - uint256(engineGenesis)) / engineRoundLength;
        }
        return uint256(engineGenesis) + (current + uint256(engineRestRounds) + 1)
            * uint256(engineRoundLength) + RETRY_MARGIN;
    }

    function _validatePlacementRound(uint64 quicknetRound) private view {
        uint64 releaseAt = quicknetReleaseTime(quicknetRound);
        uint256 earliest = block.timestamp + uint256(engineRevealDelay) + REVEAL_GUARD;
        uint256 latest = block.timestamp + uint256(engineRevealDelay)
            + uint256(engineRevealWindow) - RETRY_MARGIN;
        if (uint256(releaseAt) < earliest || uint256(releaseAt) > latest) {
            revert ReleaseOutsideSafeWindow(releaseAt, earliest, latest);
        }
    }

    // ------------------------------------------------ coupon and recovery

    /// @notice Relay a coupon claim whose proved holder is fixed to this account.
    /// @dev The caller chooses no payout address and this forwards no value.
    function claimCoupon(
        ISessionCouponClaimer distributor,
        uint256 index,
        uint256 position,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (address(distributor).code.length == 0) {
            revert InvalidCouponTarget(address(distributor));
        }
        distributor.claim(index, address(this), position, amount, proof);
    }

    /// @notice Recover native or ERC-20-facade assets only to the fixed router.
    /// @dev The recovery signer authorizes a strict nonce. No destination or
    ///      arbitrary calldata enters this function.
    function recoverToRouter(
        address asset,
        uint256 amount,
        uint256 noteCommitment,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (noteCommitment == 0) revert ZeroCommitment();
        uint256 expected = recoveryNonce;
        if (nonce != expected) revert InvalidRecoveryNonce(nonce, expected);
        _requireSigner(
            recoverySigner,
            recoveryAuthorizationDigest(asset, amount, noteCommitment, nonce),
            signature
        );

        recoveryNonce = nonce + 1;
        if (asset == address(0)) {
            uint256 balance = address(this).balance;
            if (balance < amount) revert InsufficientNativeBalance(balance, amount);
            router.routeNative{value: amount}(noteCommitment);
            return;
        }

        if (!ICashToken(asset).transfer(address(router), amount)) {
            revert TokenRecoveryFailed(asset);
        }
        router.routeToken(asset, amount, noteCommitment);
    }

    function _requireSigner(address expected, bytes32 digest, bytes calldata signature)
        private
        pure
    {
        uint256 length = signature.length;
        if (length != 65) revert InvalidSignatureLength(length);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v != 27 && v != 28) revert InvalidSignatureV(v);
        if (uint256(s) > SECP256K1N_DIV_2) revert InvalidSignatureS(s);

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != expected) {
            revert InvalidSigner(recovered, expected);
        }
    }
}
