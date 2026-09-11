// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ICashToken} from "../src/interfaces/ICashToken.sol";
import {ICompliance} from "../src/interfaces/ICompliance.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {MatchingEngine} from "../src/market/MatchingEngine.sol";
import {MatchingEngineBase} from "../src/market/MatchingEngineBase.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {OrderBookBase} from "../src/market/OrderBookBase.sol";
import {
    ISessionCouponClaimer,
    ISessionEngine,
    SessionAccount
} from "../src/session/SessionAccount.sol";
import {AtsHolds} from "./AtsHolds.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

contract SessionRecoveryRouter {
    uint256 public lastCommitment;
    address public lastAsset;
    uint256 public lastAmount;

    function routeNative(uint256 commitment) external payable returns (uint256 root) {
        lastCommitment = commitment;
        lastAsset = address(0);
        lastAmount = msg.value;
        return commitment;
    }

    function routeToken(address asset, uint256 amount, uint256 commitment)
        external
        returns (uint256 root)
    {
        lastCommitment = commitment;
        lastAsset = asset;
        lastAmount = amount;
        return commitment;
    }
}

contract SessionCashToken is ICashToken {
    mapping(address => uint256) private _balances;

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        uint256 available = _balances[msg.sender];
        require(available >= amount, "balance");
        _balances[msg.sender] = available - amount;
        _balances[to] += amount;
        return true;
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }
}

contract SessionCouponClaimer is ISessionCouponClaimer {
    address public holder;
    uint256 public index;
    uint256 public amount;

    function claim(
        uint256 index_,
        address holder_,
        uint256,
        uint256 amount_,
        bytes32[] calldata
    ) external override {
        index = index_;
        holder = holder_;
        amount = amount_;
    }
}

/// @dev Constant engine used only for address-independent hash vectors.
contract SessionVectorEngine is ISessionEngine {
    bytes32 private constant DOMAIN_ORDER = keccak256("hedera2026.orderbook.v1");
    address private constant VECTOR_SECURITY =
        address(0x3333333333333333333333333333333333333333);
    bytes32 private constant VECTOR_PARTITION = bytes32(uint256(9));

    function commit(bytes32) external payable override {
        revert("vector only");
    }

    function reveal(OrderBook.Side, uint128, uint128, bytes32, uint256)
        external
        payable
        override
    {
        revert("vector only");
    }

    function cancel(bytes32) external pure override {
        revert("vector only");
    }

    function expire(bytes32) external pure override {
        revert("vector only");
    }

    function withdraw() external pure override {
        revert("vector only");
    }

    function commitmentOf(
        address committer,
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 salt
    ) external pure override returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_ORDER, committer, side, price, qty, salt));
    }

    function commitBond() external pure override returns (uint256) {
        return 0.01 ether;
    }

    function commitments(bytes32)
        external
        pure
        override
        returns (address, uint64, bool, bool, uint256)
    {
        return (address(0), 0, false, false, 0);
    }

    function revealDelay() external pure override returns (uint64) {
        return 5 minutes;
    }

    function revealWindow() external pure override returns (uint64) {
        return 30 minutes;
    }

    function roundLength() external pure override returns (uint64) {
        return 5 minutes;
    }

    function restRounds() external pure override returns (uint64) {
        return 7;
    }

    function genesis() external pure override returns (uint64) {
        return 2_000_000_000;
    }

    function security() external pure override returns (IHoldByPartition) {
        return IHoldByPartition(VECTOR_SECURITY);
    }

    function partition() external pure override returns (bytes32) {
        return VECTOR_PARTITION;
    }
}

contract SessionAccountTest is Test, PolicyFixture {
    struct Ticket {
        OrderBook.Side side;
        uint128 price;
        uint128 qty;
        bytes32 randomSalt;
        bytes32 envelopeDigest;
        uint64 round;
        bytes32 engineSalt;
        bytes32 id;
    }

    uint256 internal constant SESSION_KEY = 0xA11CE;
    uint256 internal constant RECOVERY_KEY = 0xB0B;
    uint256 internal constant WRONG_KEY = 0xBAD;
    uint256 internal constant SECP256K1N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint64 internal constant ROUND_LENGTH = 5 minutes;
    uint64 internal constant REST = 7;
    uint64 internal constant QUICKNET_GENESIS = 1_692_803_367;
    uint64 internal constant QUICKNET_PERIOD = 3;
    uint64 internal constant REVEAL_GUARD = 12;
    uint64 internal constant RETRY_MARGIN = 60;
    uint256 internal constant BOND = 0.01 ether;
    uint256 internal constant BUY_HARD_CAP = 384_666;
    uint256 internal constant SELL_HARD_CAP = 828_046;
    uint256 internal constant PUBLISHED_DIRECT_SELL_BASELINE = 720_040;
    uint256 internal constant TWO_TRANSACTION_INTRINSIC_BUDGET = 51_000;
    uint256 internal constant CANCEL_FEE =
        (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);
    uint64 internal constant BASE_TIME = 2_000_000_000;
    bytes32 internal constant PARTITION = bytes32(uint256(9));
    bytes32 internal constant QUICKNET_CHAIN_HASH =
        0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;
    bytes32 internal constant FEE_POLICY =
        0xd74242b49f657e09305d83d2f31d1f2437e492538673004b14e948ba7a701037;

    address internal constant RELAYER = address(0xBEEF);
    address internal constant SQUATTER = address(0x515151);
    address internal constant DIRECT_SELLER = address(0xD1CE7);
    address internal constant VECTOR_ACCOUNT =
        address(0x1111111111111111111111111111111111111111);
    address internal constant VECTOR_ENGINE =
        address(0x2222222222222222222222222222222222222222);
    address internal constant VECTOR_SECURITY =
        address(0x3333333333333333333333333333333333333333);
    address payable internal constant VECTOR_ROUTER =
        payable(address(0x4444444444444444444444444444444444444444));
    bytes32 internal constant VECTOR_ENVELOPE =
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    bytes32 internal constant VECTOR_RANDOM_SALT =
        0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    uint64 internal constant VECTOR_ROUND = 123_456_789;

    AtsHolds internal ats;
    MatchingEngine internal engine;
    SessionRecoveryRouter internal router;
    SessionAccount internal account;

    address internal sessionSigner;
    address internal recoverySigner;

    function setUp() public {
        vm.chainId(296);
        vm.warp(BASE_TIME);
        _deployPolicy(asDeployed());

        sessionSigner = vm.addr(SESSION_KEY);
        recoverySigner = vm.addr(RECOVERY_KEY);
        ats = new AtsHolds();
        engine = new MatchingEngine(
            DELAY,
            WINDOW,
            BOND,
            CANCEL_FEE,
            params,
            ROUND_LENGTH,
            REST,
            ats,
            PARTITION,
            _allowAllCompliance()
        );
        router = new SessionRecoveryRouter();
        account = _newAccount();

        vm.deal(address(account), 100 ether);
        ats.mint(PARTITION, address(account), 10_000_000);
        vm.deal(SQUATTER, 1 ether);
    }

    function test_validBuyUsesTheAccountAsCommitterAndTrader() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 105, 1_000, bytes32(uint256(11)), keccak256("buy-envelope")
        );
        uint256 beforeBalance = address(account).balance;

        _place(ticket);
        (address committer, uint64 committedAt, bool revealed,, uint256 bond) =
            engine.commitments(ticket.id);
        assertEq(committer, address(account));
        assertEq(committedAt, BASE_TIME);
        assertFalse(revealed);
        assertEq(bond, BOND);

        _warpToRelease(ticket);
        vm.prank(RELAYER);
        bytes32 returned = account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        assertEq(returned, ticket.id);
        (address trader,,,,,,,,) = engine.orders(ticket.id);
        assertEq(trader, address(account));
        (,, uint256 escrow) = engine.backingOf(ticket.id);
        assertEq(escrow, uint256(ticket.price) * ticket.qty);
        assertEq(
            address(account).balance, beforeBalance - BOND - uint256(ticket.price) * ticket.qty
        );
    }

    function test_validSellCreatesTheHoldFromTheSessionTokenHolder() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.SELL, 95, 1_000, bytes32(uint256(12)), keccak256("sell-envelope")
        );
        _place(ticket);
        _warpToRelease(ticket);

        uint256 freeBefore = ats.balanceOfByPartition(PARTITION, address(account));
        vm.prank(RELAYER);
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        (uint256 holdId, uint256 snapshot,) = engine.backingOf(ticket.id);
        assertTrue(holdId != 0);
        assertEq(snapshot, ticket.qty);
        (uint256 amount, uint256 expiry, address escrow, address destination,,,) =
            ats.getHoldForByPartition(_holdIdentifier(holdId));
        assertEq(amount, ticket.qty);
        assertEq(escrow, address(engine));
        assertEq(destination, address(0));
        assertGe(expiry, engine.roundEnd(engine.currentRound() + REST));
        assertEq(ats.balanceOfByPartition(PARTITION, address(account)), freeBefore - ticket.qty);
    }

    function test_revealIsPermissionlessButCannotRunBeforeTimedRelease() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 10, 2, bytes32(uint256(13)), keccak256("timed-envelope")
        );
        _place(ticket);

        uint64 releaseAt = account.quicknetReleaseTime(ticket.round);
        vm.warp(releaseAt - 1);
        vm.prank(address(0xCAFE));
        vm.expectRevert(
            abi.encodeWithSelector(SessionAccount.TimedReleasePending.selector, releaseAt)
        );
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        vm.warp(releaseAt);
        vm.prank(address(0xCAFE));
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );
        (address trader,,,,,,,,) = engine.orders(ticket.id);
        assertEq(trader, address(account));
    }

    function test_exactPlaceReplayFailsInPermanentEngineState() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 12, 3, bytes32(uint256(14)), keccak256("replay-envelope")
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
        vm.expectRevert(
            abi.encodeWithSelector(OrderBookBase.AlreadyCommitted.selector, ticket.id)
        );
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
    }

    function test_wrongSignerIsRefused() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 13, 4, bytes32(uint256(15)), keccak256("wrong-signer-envelope")
        );
        bytes memory signature = _sign(
            WRONG_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        vm.expectPartialRevert(SessionAccount.InvalidSigner.selector);
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
    }

    function test_highSSignatureIsRefused() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 14, 5, bytes32(uint256(16)), keccak256("high-s-envelope")
        );
        bytes32 digest =
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, digest);
        bytes32 highS = bytes32(SECP256K1N - uint256(s));
        uint8 highV = v == 27 ? 28 : 27;

        vm.expectRevert(
            abi.encodeWithSelector(SessionAccount.InvalidSignatureS.selector, highS)
        );
        account.placeSealed(
            ticket.id, ticket.envelopeDigest, ticket.round, abi.encodePacked(r, highS, highV)
        );
    }

    function test_wrongEip712ChainDomainIsRefused() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 15, 6, bytes32(uint256(17)), keccak256("wrong-domain-envelope")
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        vm.chainId(297);
        vm.expectPartialRevert(SessionAccount.InvalidSigner.selector);
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
    }

    function test_roundBeforeSafeGuardIsRefused() public {
        uint64 round = _roundAtOrAfter(BASE_TIME + 10_000);
        uint64 releaseAt = account.quicknetReleaseTime(round);
        vm.warp(uint256(releaseAt) - DELAY - REVEAL_GUARD + 1);
        Ticket memory ticket = _ticketAtRound(
            OrderBook.Side.BUY,
            16,
            7,
            bytes32(uint256(18)),
            keccak256("early-round-envelope"),
            round
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, round)
        );

        vm.expectPartialRevert(SessionAccount.ReleaseOutsideSafeWindow.selector);
        account.placeSealed(ticket.id, ticket.envelopeDigest, round, signature);
    }

    function test_roundAfterRetryMarginIsRefused() public {
        uint64 round = _roundAtOrAfter(BASE_TIME + 12_000);
        uint64 releaseAt = account.quicknetReleaseTime(round);
        vm.warp(uint256(releaseAt) - DELAY - WINDOW + RETRY_MARGIN - 1);
        Ticket memory ticket = _ticketAtRound(
            OrderBook.Side.BUY,
            17,
            8,
            bytes32(uint256(19)),
            keccak256("late-round-envelope"),
            round
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, round)
        );

        vm.expectPartialRevert(SessionAccount.ReleaseOutsideSafeWindow.selector);
        account.placeSealed(ticket.id, ticket.envelopeDigest, round, signature);
    }

    function test_squattedCommitmentIsRefusedBeforeBackingMoves() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.SELL, 95, 900, bytes32(uint256(20)), keccak256("squatted-envelope")
        );
        vm.prank(SQUATTER);
        engine.commit{value: BOND}(ticket.id);

        _warpToRelease(ticket);
        uint256 freeBefore = ats.balanceOfByPartition(PARTITION, address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionAccount.CommitmentOwnerMismatch.selector, ticket.id, SQUATTER
            )
        );
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );
        assertEq(ats.balanceOfByPartition(PARTITION, address(account)), freeBefore);
        assertEq(ats.created(), 0);
    }

    function test_signedCancelIsSeparateAndItsReplayFails() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 18, 9, bytes32(uint256(21)), keccak256("cancel-envelope")
        );
        _place(ticket);
        bytes memory cancelSignature = _sign(
            SESSION_KEY,
            account.cancelAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        vm.prank(RELAYER);
        account.cancelAuthorized(
            ticket.id, ticket.envelopeDigest, ticket.round, cancelSignature
        );
        assertEq(engine.credit(address(account)), BOND - CANCEL_FEE);

        vm.expectRevert(
            abi.encodeWithSelector(OrderBookBase.AlreadyCancelled.selector, ticket.id)
        );
        account.cancelAuthorized(
            ticket.id, ticket.envelopeDigest, ticket.round, cancelSignature
        );

        uint256 beforeBalance = address(account).balance;
        vm.prank(address(0xCAFE));
        account.sweepEngineCredit();
        assertEq(address(account).balance, beforeBalance + BOND - CANCEL_FEE);
        assertEq(engine.credit(address(account)), 0);
    }

    function test_expireIsPermissionlessAndCreditsTheSessionAccount() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 21, 10, bytes32(uint256(211)), keccak256("expire-envelope")
        );
        _place(ticket);
        _warpToRelease(ticket);
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );
        (,,,,,,, uint64 lastRound,) = engine.orders(ticket.id);

        vm.warp(engine.roundEnd(lastRound) + 1);
        vm.prank(address(0xCAFE));
        account.expire(ticket.id);

        (,,,,,,,, bool retired) = engine.orders(ticket.id);
        assertTrue(retired);
        assertEq(engine.credit(address(account)), BOND + uint256(ticket.price) * ticket.qty);
    }

    function test_placeSignatureCannotAuthorizeCancel() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 19, 10, bytes32(uint256(22)), keccak256("cross-method-envelope")
        );
        _place(ticket);
        bytes memory placeSignature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        vm.expectPartialRevert(SessionAccount.InvalidSigner.selector);
        account.cancelAuthorized(ticket.id, ticket.envelopeDigest, ticket.round, placeSignature);
    }

    function test_buyInsufficientHbarLeavesCommitmentUnrevealed() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 1 ether, 2, bytes32(uint256(23)), keccak256("poor-buy-envelope")
        );
        _place(ticket);
        _warpToRelease(ticket);

        uint256 required = uint256(ticket.price) * ticket.qty;
        vm.deal(address(account), required - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionAccount.InsufficientNativeBalance.selector, required - 1, required
            )
        );
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        _assertUnrevealed(ticket.id);
        (address trader,,,,,,,,) = engine.orders(ticket.id);
        assertEq(trader, address(0));
    }

    function test_sellAtsFailureLeavesEngineAndTokenStateUntouched() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.SELL,
            20,
            500,
            bytes32(uint256(24)),
            keccak256("ats-failure-envelope")
        );
        _place(ticket);
        _warpToRelease(ticket);
        uint256 freeBefore = ats.balanceOfByPartition(PARTITION, address(account));
        ats.setRevertNextCreate(true);

        vm.expectRevert(AtsHolds.InjectedHoldFailure.selector);
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        _assertUnrevealed(ticket.id);
        assertEq(ats.balanceOfByPartition(PARTITION, address(account)), freeBefore);
        assertEq(ats.created(), 0);
    }

    function test_engineFailureRollsBackTheNewSellHold() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.SELL,
            uint128(1 << 96),
            501,
            bytes32(uint256(25)),
            keccak256("engine-failure-envelope")
        );
        _place(ticket);
        _warpToRelease(ticket);
        uint256 freeBefore = ats.balanceOfByPartition(PARTITION, address(account));
        uint256 nextIdBefore = ats.nextId();

        vm.expectRevert(
            abi.encodeWithSelector(MatchingEngineBase.OutOfRange.selector, ticket.price)
        );
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );

        _assertUnrevealed(ticket.id);
        assertEq(ats.balanceOfByPartition(PARTITION, address(account)), freeBefore);
        assertEq(ats.nextId(), nextIdBefore);
        assertEq(ats.created(), 0);
    }

    function test_recoveryRoutesNativeAndTokensOnlyToConfiguredRouter() public {
        uint256 nativeAmount = 2 ether;
        uint256 nativeCommitment = 101;
        bytes memory nativeSignature = _sign(
            RECOVERY_KEY,
            account.recoveryAuthorizationDigest(
                address(0), nativeAmount, nativeCommitment, 0
            )
        );
        uint256 routerBefore = address(router).balance;

        vm.prank(RELAYER);
        account.recoverToRouter(
            address(0), nativeAmount, nativeCommitment, 0, nativeSignature
        );
        assertEq(address(router).balance, routerBefore + nativeAmount);
        assertEq(router.lastCommitment(), nativeCommitment);
        assertEq(account.recoveryNonce(), 1);

        vm.expectRevert(
            abi.encodeWithSelector(SessionAccount.InvalidRecoveryNonce.selector, 0, 1)
        );
        account.recoverToRouter(
            address(0), nativeAmount, nativeCommitment, 0, nativeSignature
        );

        SessionCashToken cash = new SessionCashToken();
        cash.mint(address(account), 1_000);
        uint256 tokenCommitment = 202;
        bytes memory tokenSignature =
            _sign(
                RECOVERY_KEY,
                account.recoveryAuthorizationDigest(
                    address(cash), 600, tokenCommitment, 1
                )
            );
        vm.prank(address(0xCAFE));
        account.recoverToRouter(
            address(cash), 600, tokenCommitment, 1, tokenSignature
        );
        assertEq(cash.balanceOf(address(router)), 600);
        assertEq(cash.balanceOf(address(account)), 400);
        assertEq(router.lastCommitment(), tokenCommitment);
        assertEq(router.lastAsset(), address(cash));
        assertEq(account.recoveryNonce(), 2);

        (bool arbitraryOk,) = address(account)
            .call(
                abi.encodeWithSignature(
                    "execute(address,uint256,bytes)", address(0xDEAD), 1 ether, bytes("")
                )
            );
        assertFalse(arbitraryOk, "the account must not expose arbitrary execution");
    }

    function test_sessionSignerCannotUseRecoverySurface() public {
        uint256 commitment = 303;
        bytes memory wrongSignature =
            _sign(
                SESSION_KEY,
                account.recoveryAuthorizationDigest(address(0), 1 ether, commitment, 0)
            );
        vm.expectPartialRevert(SessionAccount.InvalidSigner.selector);
        account.recoverToRouter(address(0), 1 ether, commitment, 0, wrongSignature);
        assertEq(account.recoveryNonce(), 0);
    }

    function test_recoveryRefusesAZeroNoteCommitmentBeforeMovingAssets() public {
        vm.expectRevert(SessionAccount.ZeroCommitment.selector);
        account.recoverToRouter(address(0), 1 ether, 0, 0, "");
        assertEq(account.recoveryNonce(), 0);
    }

    function test_couponRelayFixesTheHolderToTheSessionAccount() public {
        SessionCouponClaimer coupon = new SessionCouponClaimer();
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("proof");

        vm.prank(RELAYER);
        account.claimCoupon(coupon, 4, 7, 123, proof);
        assertEq(coupon.holder(), address(account));
        assertEq(coupon.index(), 4);
        assertEq(coupon.amount(), 123);
    }

    function test_hashVectorsAreExact() public {
        SessionVectorEngine vectorTemplate = new SessionVectorEngine();
        vm.etch(VECTOR_ENGINE, address(vectorTemplate).code);
        vm.etch(VECTOR_ROUTER, hex"00");
        SessionAccount accountTemplate = new SessionAccount(
            address(0x5555555555555555555555555555555555555555),
            address(0x6666666666666666666666666666666666666666),
            ISessionEngine(VECTOR_ENGINE),
            IHoldByPartition(VECTOR_SECURITY),
            PARTITION,
            VECTOR_ROUTER,
            QUICKNET_CHAIN_HASH,
            7,
            FEE_POLICY
        );
        vm.etch(VECTOR_ACCOUNT, address(accountTemplate).code);
        SessionAccount vector = SessionAccount(payable(VECTOR_ACCOUNT));

        bytes32 metadata = vector.automationMetadata(VECTOR_ENVELOPE, VECTOR_ROUND);
        bytes32 derivedSalt =
            vector.engineSalt(VECTOR_ENVELOPE, VECTOR_ROUND, VECTOR_RANDOM_SALT);
        bytes32 commitment = vector.commitmentFor(
            OrderBook.Side.SELL,
            1_000_000,
            500,
            VECTOR_RANDOM_SALT,
            VECTOR_ENVELOPE,
            VECTOR_ROUND
        );
        bytes32 placeDigest =
            vector.placeAuthorizationDigest(commitment, VECTOR_ENVELOPE, VECTOR_ROUND);
        bytes32 recoveryDigest =
            vector.recoveryAuthorizationDigest(VECTOR_SECURITY, 600, 777, 3);

        emit log_named_bytes32("session metadata vector", metadata);
        emit log_named_bytes32("session engine salt vector", derivedSalt);
        emit log_named_bytes32("session commitment vector", commitment);
        emit log_named_bytes32("session place digest vector", placeDigest);
        emit log_named_bytes32("session recovery digest vector", recoveryDigest);

        assertEq(metadata, 0x307c197bc1f0c3d6db7538008016e4c3c041b627c10ed296cb3840b36ba9ff74);
        assertEq(
            derivedSalt, 0x6ba205bd2d0525c5630be8ef7b16d4b41ee0892a5433172f91d5ccaefb2791c8
        );
        assertEq(commitment, 0x2c052fc599b1c3abbcfaa2fbe165d92b1fa99596f5ce8ced537b2c8af4628680);
        assertEq(
            recoveryDigest,
            0x6e1628d94b93cd08c5fe7f885ffcd7cfdb5c16a11010e5943b3fb975bd924bbc
        );
        assertEq(
            placeDigest, 0x39c80c80e69e655d6d0543bf2c6c87e353c5305ab9155e2216d1744dad3de0f3
        );
        assertEq(
            metadata,
            keccak256(
                abi.encode(
                    vector.AUTOMATION_DOMAIN(),
                    QUICKNET_CHAIN_HASH,
                    VECTOR_ACCOUNT,
                    uint64(7),
                    VECTOR_ENGINE,
                    VECTOR_ENVELOPE,
                    VECTOR_ROUND,
                    FEE_POLICY
                )
            )
        );
        assertEq(derivedSalt, keccak256(abi.encode(metadata, VECTOR_RANDOM_SALT)));
        assertEq(
            commitment,
            keccak256(
                abi.encode(
                    keccak256("hedera2026.orderbook.v1"),
                    VECTOR_ACCOUNT,
                    OrderBook.Side.SELL,
                    uint128(1_000_000),
                    uint128(500),
                    derivedSalt
                )
            )
        );
        assertTrue(placeDigest != bytes32(0));
    }

    function test_gasBuyEntryStaysUnderTheLocalHardCap() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.BUY, 105, 1_000, bytes32(uint256(31)), keccak256("gas-buy-envelope")
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        _coolOrderPath();
        vm.prank(RELAYER);
        uint256 gasBefore = gasleft();
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
        uint256 placeGas = gasBefore - gasleft();

        _warpToRelease(ticket);
        _coolOrderPath();
        vm.prank(RELAYER);
        gasBefore = gasleft();
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );
        uint256 revealGas = gasBefore - gasleft();
        uint256 projected = placeGas + revealGas + TWO_TRANSACTION_INTRINSIC_BUDGET;

        emit log_named_uint("SessionAccount BUY place execution gas", placeGas);
        emit log_named_uint("SessionAccount BUY reveal execution gas", revealGas);
        emit log_named_uint("SessionAccount BUY projected entry gas", projected);
        assertLe(projected, BUY_HARD_CAP);
    }

    function test_gasSellEntryStaysUnderTheLocalHardCap() public {
        Ticket memory ticket = _ticket(
            OrderBook.Side.SELL, 95, 1_000, bytes32(uint256(32)), keccak256("gas-sell-envelope")
        );
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );

        uint256 snapshot = vm.snapshotState();
        (uint256 directHoldGas, uint256 directCommitGas, uint256 directRevealGas) =
            _measureDirectSell();
        assertTrue(vm.revertToStateAndDelete(snapshot));

        _coolOrderPath();
        vm.prank(RELAYER);
        uint256 gasBefore = gasleft();
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
        uint256 placeGas = gasBefore - gasleft();

        _warpToRelease(ticket);
        _coolOrderPath();
        vm.prank(RELAYER);
        gasBefore = gasleft();
        account.revealAuthorized(
            ticket.side,
            ticket.price,
            ticket.qty,
            ticket.randomSalt,
            ticket.envelopeDigest,
            ticket.round
        );
        uint256 revealGas = gasBefore - gasleft();
        uint256 localMockProjection = placeGas + revealGas + TWO_TRANSACTION_INTRINSIC_BUDGET;
        uint256 sessionExecution = placeGas + revealGas;
        uint256 directExecution = directHoldGas + directCommitGas + directRevealGas;
        uint256 measuredOverhead =
            sessionExecution > directExecution ? sessionExecution - directExecution : 0;
        uint256 adjustedProductionProjection = PUBLISHED_DIRECT_SELL_BASELINE + measuredOverhead;

        emit log_named_uint("SessionAccount SELL place execution gas", placeGas);
        emit log_named_uint("SessionAccount SELL reveal execution gas", revealGas);
        emit log_named_uint("SessionAccount SELL mock projected entry gas", localMockProjection);
        emit log_named_uint("SessionAccount SELL measured wrapper overhead", measuredOverhead);
        emit log_named_uint(
            "SessionAccount SELL adjusted production projection", adjustedProductionProjection
        );
        assertLe(localMockProjection, SELL_HARD_CAP);
        assertLe(adjustedProductionProjection, SELL_HARD_CAP);
    }

    function _newAccount() private returns (SessionAccount) {
        return new SessionAccount(
            sessionSigner,
            recoverySigner,
            ISessionEngine(address(engine)),
            ats,
            PARTITION,
            payable(address(router)),
            QUICKNET_CHAIN_HASH,
            1,
            FEE_POLICY
        );
    }

    function _ticket(
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 randomSalt,
        bytes32 envelopeDigest
    ) private view returns (Ticket memory) {
        return _ticketAtRound(
            side, price, qty, randomSalt, envelopeDigest, _validQuicknetRound()
        );
    }

    function _ticketAtRound(
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 randomSalt,
        bytes32 envelopeDigest,
        uint64 round
    ) private view returns (Ticket memory ticket) {
        bytes32 salt = account.engineSalt(envelopeDigest, round, randomSalt);
        ticket = Ticket({
            side: side,
            price: price,
            qty: qty,
            randomSalt: randomSalt,
            envelopeDigest: envelopeDigest,
            round: round,
            engineSalt: salt,
            id: engine.commitmentOf(address(account), side, price, qty, salt)
        });
    }

    function _place(Ticket memory ticket) private {
        bytes memory signature = _sign(
            SESSION_KEY,
            account.placeAuthorizationDigest(ticket.id, ticket.envelopeDigest, ticket.round)
        );
        vm.prank(RELAYER);
        account.placeSealed(ticket.id, ticket.envelopeDigest, ticket.round, signature);
    }

    function _warpToRelease(Ticket memory ticket) private {
        vm.warp(account.quicknetReleaseTime(ticket.round));
    }

    function _coolOrderPath() private {
        vm.cool(address(account));
        vm.cool(address(engine));
        vm.cool(address(ats));
        vm.cool(address(params));
        vm.cool(address(regime));
        vm.cool(address(clock));
    }

    function _measureDirectSell()
        private
        returns (uint256 holdGas, uint256 commitGas, uint256 revealGas)
    {
        vm.deal(DIRECT_SELLER, 1 ether);
        ats.mint(PARTITION, DIRECT_SELLER, 1_000);
        bytes32 salt = keccak256("direct-sell-gas-salt");
        bytes32 id = engine.commitmentOf(DIRECT_SELLER, OrderBook.Side.SELL, 95, 1_000, salt);

        _coolOrderPath();
        vm.prank(DIRECT_SELLER);
        uint256 gasBefore = gasleft();
        (bool success, uint256 holdId) = ats.createHoldByPartition(
            PARTITION,
            IHoldTypes.Hold({
                amount: 1_000,
                expirationTimestamp: block.timestamp + 30 days,
                escrow: address(engine),
                to: address(0),
                data: ""
            })
        );
        holdGas = gasBefore - gasleft();
        assertTrue(success);

        _coolOrderPath();
        vm.prank(DIRECT_SELLER);
        gasBefore = gasleft();
        engine.commit{value: BOND}(id);
        commitGas = gasBefore - gasleft();

        vm.warp(block.timestamp + DELAY);
        _coolOrderPath();
        vm.prank(DIRECT_SELLER);
        gasBefore = gasleft();
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, salt, holdId);
        revealGas = gasBefore - gasleft();
    }

    function _validQuicknetRound() private view returns (uint64) {
        return _roundAtOrAfter(block.timestamp + DELAY + REVEAL_GUARD + 30);
    }

    function _roundAtOrAfter(uint256 timestamp) private pure returns (uint64) {
        if (timestamp <= QUICKNET_GENESIS) return 1;
        uint256 delta = timestamp - QUICKNET_GENESIS;
        uint256 round = (delta + QUICKNET_PERIOD - 1) / QUICKNET_PERIOD + 1;
        require(round <= type(uint64).max, "round overflow");
        // The checked bound immediately above proves the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(round);
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertUnrevealed(bytes32 id) private view {
        (address committer,, bool revealed, bool cancelled, uint256 bond) =
            engine.commitments(id);
        assertEq(committer, address(account));
        assertFalse(revealed);
        assertFalse(cancelled);
        assertEq(bond, BOND);
    }

    function _holdIdentifier(uint256 holdId)
        private
        view
        returns (IHoldTypes.HoldIdentifier memory)
    {
        return IHoldTypes.HoldIdentifier({
            partition: PARTITION, tokenHolder: address(account), holdId: holdId
        });
    }

    function _allowAllCompliance() private returns (ICompliance) {
        return ICompliance(address(new SessionAllowAllCompliance()));
    }
}

contract SessionAllowAllCompliance is ICompliance {
    function canTransfer(address, address, uint256 amount)
        external
        pure
        override
        returns (bool)
    {
        return amount != 0;
    }

    function transferred(address, address, uint256) external pure override {}
    function created(address, uint256) external pure override {}
    function destroyed(address, uint256) external pure override {}
}
