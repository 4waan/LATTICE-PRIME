// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {
    ICanonicalSessionFactory,
    IFixedRecoveryPool,
    IRecoveryToken,
    SessionRecoveryRouter
} from "../src/session/SessionRecoveryRouter.sol";

contract RecoveryFactoryMock is ICanonicalSessionFactory {
    mapping(address => bool) public override isSessionAccount;

    function setCanonical(address account, bool canonical) external {
        isSessionAccount[account] = canonical;
    }
}

contract RecoveryTokenMock is IRecoveryToken {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RecoveryPoolMock is IFixedRecoveryPool {
    address public immutable override asset;
    uint256 public immutable override denomination;
    RecoveryTokenMock public immutable token;
    uint256 public lastCommitment;
    uint256 public deposits;

    constructor(address asset_, uint256 denomination_, RecoveryTokenMock token_) {
        asset = asset_;
        denomination = denomination_;
        token = token_;
    }

    function deposit(uint256 commitment) external payable returns (uint256 root) {
        if (asset == address(0)) {
            require(msg.value == denomination, "value");
        } else {
            require(msg.value == 0, "no value");
            require(token.transferFrom(msg.sender, address(this), denomination), "transfer");
        }
        lastCommitment = commitment;
        deposits += 1;
        return uint256(keccak256(abi.encode(commitment, deposits)));
    }
}

contract SessionRecoveryRouterTest is Test {
    uint256 internal constant HBAR_DENOMINATION = 10 ether;
    uint256 internal constant LPRC_DENOMINATION = 100;

    RecoveryFactoryMock internal factory;
    RecoveryTokenMock internal token;
    RecoveryPoolMock internal hbarPool;
    RecoveryPoolMock internal lprcPool;
    SessionRecoveryRouter internal router;

    function setUp() public {
        factory = new RecoveryFactoryMock();
        token = new RecoveryTokenMock();
        hbarPool = new RecoveryPoolMock(address(0), HBAR_DENOMINATION, token);
        lprcPool =
            new RecoveryPoolMock(address(token), LPRC_DENOMINATION, token);
        router = new SessionRecoveryRouter(factory, token, hbarPool, lprcPool);
        factory.setCanonical(address(this), true);
    }

    function test_nativeRecoveryRoutesExactDenominationAndCommitment() public {
        uint256 commitment = 111;
        uint256 root = router.routeNative{value: HBAR_DENOMINATION}(commitment);

        assertTrue(root != 0);
        assertEq(hbarPool.lastCommitment(), commitment);
        assertEq(address(hbarPool).balance, HBAR_DENOMINATION);

        vm.expectPartialRevert(SessionRecoveryRouter.WrongRecoveryAmount.selector);
        router.routeNative{value: HBAR_DENOMINATION - 1}(222);
    }

    function test_tokenRecoveryConsumesOnlyTheFixedDenomination() public {
        token.mint(address(router), LPRC_DENOMINATION);
        uint256 commitment = 333;
        uint256 root =
            router.routeToken(address(token), LPRC_DENOMINATION, commitment);

        assertTrue(root != 0);
        assertEq(lprcPool.lastCommitment(), commitment);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(lprcPool)), LPRC_DENOMINATION);
        assertEq(token.allowance(address(router), address(lprcPool)), 0);
    }

    function test_noncanonicalWrongAssetAndWrongAmountFailClosed() public {
        address outsider = address(0xBAD);
        vm.deal(outsider, HBAR_DENOMINATION);
        vm.expectPartialRevert(SessionRecoveryRouter.NotCanonicalSession.selector);
        vm.prank(outsider);
        router.routeNative{value: HBAR_DENOMINATION}(444);

        vm.expectPartialRevert(SessionRecoveryRouter.WrongRecoveryAsset.selector);
        router.routeToken(address(0x1234), LPRC_DENOMINATION, 555);

        vm.expectPartialRevert(SessionRecoveryRouter.WrongRecoveryAmount.selector);
        router.routeToken(address(token), LPRC_DENOMINATION + 1, 666);
    }
}
