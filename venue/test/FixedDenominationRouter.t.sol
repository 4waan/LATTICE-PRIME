// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";
import {AtsHolds} from "./AtsHolds.sol";
import {
    IFixedWithdrawalVerifier,
    IFixedWithdrawalComplianceVerifier
} from "../src/router/IRouterVerifiers.sol";
import {
    IPoseidon2,
    IRouterKycRegistry,
    IRouterSessionFactory,
    IAtsRouterToken
} from "../src/router/IRouterDependencies.sol";
import {FixedDenominationRouter} from "../src/router/FixedDenominationRouter.sol";
import {HbarFixedDenominationRouter} from "../src/router/HbarFixedDenominationRouter.sol";
import {LprcFixedDenominationRouter} from "../src/router/LprcFixedDenominationRouter.sol";
import {FixedWithdrawalVerifier} from "../src/router/FixedWithdrawalVerifier.sol";
import {
    FixedWithdrawalComplianceVerifier
} from "../src/router/FixedWithdrawalComplianceVerifier.sol";

contract WithdrawalVerifierStub is IFixedWithdrawalVerifier {
    bool public answer = true;

    function setAnswer(bool next) external {
        answer = next;
    }

    function verifyProof(uint256[24] calldata, uint256[8] calldata)
        external
        view
        returns (bool)
    {
        return answer;
    }
}

contract WithdrawalComplianceVerifierStub is IFixedWithdrawalComplianceVerifier {
    bool public answer = true;

    function setAnswer(bool next) external {
        answer = next;
    }

    function verifyProof(uint256[24] calldata, uint256[14] calldata)
        external
        view
        returns (bool)
    {
        return answer;
    }
}

contract RouterRegistryStub is IRouterKycRegistry {
    mapping(address => bool) public eligible;

    function setEligible(address account, bool value) external {
        eligible[account] = value;
    }

    function getKycStatus(address account) external view returns (IKyc.KycStatus) {
        return eligible[account] ? IKyc.KycStatus.GRANTED : IKyc.KycStatus.NOT_GRANTED;
    }
}

contract RouterFactoryStub is IRouterSessionFactory {
    mapping(address => bool) public isSessionAccount;
    mapping(address => bytes32) internal _codeHash;

    function setCanonical(address account, bool value) external {
        isSessionAccount[account] = value;
        bytes32 codeHash;
        assembly {
            codeHash := extcodehash(account)
        }
        _codeHash[account] = value ? codeHash : bytes32(0);
    }

    function deployedCodeHash(address account) external view returns (bytes32) {
        return _codeHash[account];
    }
}

contract RouterRecipient {
    receive() external payable {}
}

contract FixedDenominationRouterTest is Test {
    uint256 internal constant DENOMINATION = 100_000_000;
    uint64 internal constant MINIMUM_DELAY = 100;
    uint64 internal constant MAXIMUM_ROOT_AGE = 10_000;
    uint64 internal constant VIEW_KEY_EPOCH = 4;
    uint256 internal constant VIEW_X = 333;
    uint256 internal constant VIEW_Y = 444;
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    string internal fixture;
    WithdrawalVerifierStub internal withdrawalVerifier;
    WithdrawalComplianceVerifierStub internal complianceVerifier;
    IPoseidon2 internal poseidon;
    RouterRegistryStub internal registry;
    RouterFactoryStub internal factory;
    RouterRecipient internal recipient;

    function setUp() public {
        vm.warp(1_000);
        fixture = vm.readFile("test/fixtures/router/proofs.json");
        withdrawalVerifier = new WithdrawalVerifierStub();
        complianceVerifier = new WithdrawalComplianceVerifierStub();
        poseidon = IPoseidon2(_deployPoseidon());
        registry = new RouterRegistryStub();
        factory = new RouterFactoryStub();
        recipient = new RouterRecipient();
        factory.setCanonical(address(recipient), true);
        registry.setEligible(address(recipient), true);
    }

    function _deployPoseidon() internal returns (address deployed) {
        string memory bytecodeFixture =
            vm.readFile("test/fixtures/router/poseidon-bytecode.json");
        bytes memory creationCode = vm.parseJsonBytes(bytecodeFixture, ".creationCode");
        assembly {
            deployed := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(deployed != address(0), "poseidon deployment");
    }

    function _newHbarRouter() internal returns (HbarFixedDenominationRouter) {
        HbarFixedDenominationRouter.Config memory config = HbarFixedDenominationRouter.Config({
            admin: address(this),
            denomination: DENOMINATION,
            minimumWithdrawalDelay: MINIMUM_DELAY,
            maximumRootAge: MAXIMUM_ROOT_AGE,
            minimumRealNotes: 0,
            viewKeyEpoch: VIEW_KEY_EPOCH,
            viewKeyX: VIEW_X,
            viewKeyY: VIEW_Y
        });
        return new HbarFixedDenominationRouter(
            withdrawalVerifier, complianceVerifier, poseidon, registry, factory, config
        );
    }

    function _commitments() internal view returns (uint256[] memory) {
        return vm.parseJsonUintArray(fixture, ".commitments");
    }

    function _depositHbar(HbarFixedDenominationRouter router, uint256 count)
        internal
        returns (uint256 root)
    {
        uint256[] memory commitments = _commitments();
        for (uint256 i = 0; i < count; ++i) {
            address depositor = address(uint160(0x1000 + i));
            vm.deal(depositor, DENOMINATION);
            vm.prank(depositor);
            root = router.deposit{value: DENOMINATION}(commitments[i]);
        }
    }

    function _signals(
        FixedDenominationRouter router,
        address payable target,
        uint256 root,
        bytes32 nullifier
    )
        internal
        view
        returns (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        )
    {
        withdrawalSignals[0] = uint256(nullifier);
        withdrawalSignals[1] = 555;
        withdrawalSignals[2] = root;
        withdrawalSignals[3] = uint256(uint160(address(target)));
        withdrawalSignals[4] = uint256(uint160(address(router)));
        withdrawalSignals[5] = uint256(uint160(router.asset()));
        withdrawalSignals[6] = router.denomination();
        withdrawalSignals[7] = block.chainid;

        complianceSignals[0] = 700;
        complianceSignals[1] = 701;
        complianceSignals[2] = 702;
        complianceSignals[3] = 703;
        complianceSignals[4] = withdrawalSignals[1];
        complianceSignals[5] = withdrawalSignals[2];
        complianceSignals[6] = withdrawalSignals[3];
        complianceSignals[7] = withdrawalSignals[4];
        complianceSignals[8] = withdrawalSignals[5];
        complianceSignals[9] = withdrawalSignals[6];
        complianceSignals[10] = withdrawalSignals[7];
        complianceSignals[11] = VIEW_KEY_EPOCH;
        complianceSignals[12] = VIEW_X;
        complianceSignals[13] = VIEW_Y;

        ciphertext = FixedDenominationRouter.ComplianceCiphertext({
            encryptedCommitment: complianceSignals[0],
            tag: complianceSignals[1],
            ephemeralX: complianceSignals[2],
            ephemeralY: complianceSignals[3]
        });
    }

    function _withdraw(
        FixedDenominationRouter router,
        address payable target,
        FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
        uint256[8] memory withdrawalSignals,
        uint256[14] memory complianceSignals
    ) internal {
        uint256[24] memory withdrawalProof;
        uint256[24] memory complianceProof;
        FixedDenominationRouter.WithdrawalProofBundle memory bundle =
            FixedDenominationRouter.WithdrawalProofBundle({
                withdrawalProof: withdrawalProof,
                withdrawalPublicSignals: withdrawalSignals,
                complianceProof: complianceProof,
                compliancePublicSignals: complianceSignals
            });
        router.withdraw(target, ciphertext, bundle);
    }

    function test_realRouterProofsVerifyAndCiphertextTamperingFails() public {
        FixedWithdrawalVerifier realWithdrawalVerifier = new FixedWithdrawalVerifier();
        FixedWithdrawalComplianceVerifier realComplianceVerifier =
            new FixedWithdrawalComplianceVerifier();
        uint256[24] memory withdrawalProof = _proof(".withdrawal.proof");
        uint256[8] memory withdrawalSignals = _withdrawalPublic(".withdrawal.publicSignals");
        uint256[24] memory complianceProof = _proof(".compliance.proof");
        uint256[14] memory complianceSignals = _compliancePublic(".compliance.publicSignals");

        assertTrue(realWithdrawalVerifier.verifyProof(withdrawalProof, withdrawalSignals));
        assertTrue(realComplianceVerifier.verifyProof(complianceProof, complianceSignals));
        assertEq(withdrawalSignals[1], complianceSignals[4]);

        complianceSignals[0] ^= 1;
        assertFalse(realComplianceVerifier.verifyProof(complianceProof, complianceSignals));
    }

    function test_realPoseidonDepositsReachFixtureRoot() public {
        HbarFixedDenominationRouter router = _newHbarRouter();
        assertEq(router.minimumRealNotes(), router.DEFAULT_MINIMUM_REAL_NOTES());
        uint256 root = _depositHbar(router, 8);
        uint256[] memory acceptedRoots = vm.parseJsonUintArray(fixture, ".acceptedRoots");

        assertEq(root, acceptedRoots[7]);
        assertEq(router.currentRoot(), acceptedRoots[7]);
        assertEq(router.rootAtNoteCount(8), acceptedRoots[7]);
        uint256[] memory commitments = _commitments();
        uint256[] memory page = router.commitmentRange(0, 8);
        assertEq(page.length, 8);
        for (uint256 index = 0; index < page.length; ++index) {
            assertEq(router.commitmentAt(uint32(index)), commitments[index]);
            assertEq(page[index], commitments[index]);
        }
        vm.expectPartialRevert(FixedDenominationRouter.CommitmentRangeInvalid.selector);
        router.commitmentRange(0, 257);
        (uint64 acceptedAt, uint32 realNotes, uint32 independentFunders, bool known) =
            router.rootMetadata(root);
        assertTrue(known);
        assertEq(realNotes, 8);
        assertEq(independentFunders, 8);
        assertEq(acceptedAt, block.timestamp);
    }

    function test_configurableThresholdAndIndependentFundersFailClosed() public {
        HbarFixedDenominationRouter raisedThresholdRouter = _newHbarRouter();
        raisedThresholdRouter.setMinimumRealNotes(9);
        assertEq(raisedThresholdRouter.minimumRealNotes(), 9);

        uint256 root = _depositHbar(raisedThresholdRouter, 8);
        vm.warp(block.timestamp + MINIMUM_DELAY);
        (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        ) = _signals(
            raisedThresholdRouter, payable(address(recipient)), root, bytes32(uint256(40))
        );
        vm.expectPartialRevert(FixedDenominationRouter.AnonymityThresholdNotMet.selector);
        _withdraw(
            raisedThresholdRouter,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        HbarFixedDenominationRouter singleFunderRouter = _newHbarRouter();
        uint256[] memory commitments = _commitments();
        address depositor = address(0x4000);
        vm.deal(depositor, 8 * DENOMINATION);
        for (uint256 i = 0; i < 8; ++i) {
            vm.prank(depositor);
            root = singleFunderRouter.deposit{value: DENOMINATION}(commitments[i]);
        }
        vm.warp(block.timestamp + MINIMUM_DELAY);
        (ciphertext, withdrawalSignals, complianceSignals) = _signals(
            singleFunderRouter, payable(address(recipient)), root, bytes32(uint256(41))
        );
        vm.expectPartialRevert(
            FixedDenominationRouter.IndependentFundersThresholdNotMet.selector
        );
        _withdraw(
            singleFunderRouter,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );
    }

    function test_underThresholdEarlyUnknownAndStaleRootsFailClosed() public {
        HbarFixedDenominationRouter router = _newHbarRouter();
        uint256 root = _depositHbar(router, 7);
        vm.warp(block.timestamp + MINIMUM_DELAY);
        (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        ) = _signals(router, payable(address(recipient)), root, bytes32(uint256(1)));
        vm.expectPartialRevert(FixedDenominationRouter.AnonymityThresholdNotMet.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        uint256[] memory commitments = _commitments();
        address eighthDepositor = address(0x1007);
        vm.deal(eighthDepositor, DENOMINATION);
        vm.prank(eighthDepositor);
        root = router.deposit{value: DENOMINATION}(commitments[7]);
        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root, bytes32(uint256(2)));
        vm.expectPartialRevert(FixedDenominationRouter.RootTooYoung.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root + 1, bytes32(uint256(3)));
        vm.expectPartialRevert(FixedDenominationRouter.UnknownRoot.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        address ninthDepositor = address(0x1008);
        vm.deal(ninthDepositor, DENOMINATION);
        vm.prank(ninthDepositor);
        router.deposit{value: DENOMINATION}(123_456_789);

        vm.warp(block.timestamp + MAXIMUM_ROOT_AGE + 1);
        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root, bytes32(uint256(4)));
        vm.expectPartialRevert(FixedDenominationRouter.StaleRoot.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );
    }

    function test_wrongDenominationAssetRecipientAndProofsFailClosed() public {
        HbarFixedDenominationRouter router = _newHbarRouter();
        uint256 root = _depositHbar(router, 8);
        vm.warp(block.timestamp + MINIMUM_DELAY);
        (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        ) = _signals(router, payable(address(recipient)), root, bytes32(uint256(10)));

        withdrawalSignals[6] ^= 1;
        vm.expectPartialRevert(FixedDenominationRouter.PublicSignalMismatch.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        (, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root, bytes32(uint256(10)));
        withdrawalSignals[5] = 1;
        vm.expectPartialRevert(FixedDenominationRouter.PublicSignalMismatch.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        RouterRecipient unknown = new RouterRecipient();
        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(unknown)), root, bytes32(uint256(10)));
        vm.expectPartialRevert(FixedDenominationRouter.RecipientNotEligible.selector);
        _withdraw(
            router, payable(address(unknown)), ciphertext, withdrawalSignals, complianceSignals
        );

        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root, bytes32(uint256(10)));
        withdrawalVerifier.setAnswer(false);
        vm.expectRevert(FixedDenominationRouter.WithdrawalProofInvalid.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        withdrawalVerifier.setAnswer(true);
        complianceVerifier.setAnswer(false);
        vm.expectRevert(FixedDenominationRouter.ComplianceProofInvalid.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );
    }

    function test_hbarConservationDoubleSpendAndComplianceBinding() public {
        HbarFixedDenominationRouter router = _newHbarRouter();
        uint256 root = _depositHbar(router, 8);
        vm.warp(block.timestamp + MINIMUM_DELAY);
        bytes32 nullifier = bytes32(uint256(20));
        (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        ) = _signals(router, payable(address(recipient)), root, nullifier);

        ciphertext.tag ^= 1;
        vm.expectRevert(FixedDenominationRouter.CiphertextMismatch.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        (ciphertext, withdrawalSignals, complianceSignals) =
            _signals(router, payable(address(recipient)), root, nullifier);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        assertEq(address(router).balance, 7 * DENOMINATION);
        assertEq(address(recipient).balance, DENOMINATION);
        assertEq(router.totalDeposited(), 8 * DENOMINATION);
        assertEq(router.totalWithdrawn(), DENOMINATION);

        vm.expectPartialRevert(FixedDenominationRouter.NullifierAlreadySpent.selector);
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );
    }

    function test_lprcCanaryEligibilityHoldsAndTokenConservation() public {
        AtsHolds token = new AtsHolds();
        LprcFixedDenominationRouter router = _newLprcRouter(token);
        uint256[] memory commitments = _commitments();

        token.mint(PARTITION, address(0x1000), DENOMINATION);
        vm.prank(address(0x1000));
        token.approve(address(router), DENOMINATION);
        vm.expectRevert(LprcFixedDenominationRouter.CanaryNotActivated.selector);
        vm.prank(address(0x1000));
        router.deposit(commitments[0]);

        router.activateAtsCanary(keccak256("live ATS canary evidence"));
        vm.expectPartialRevert(FixedDenominationRouter.RecipientNotEligible.selector);
        vm.prank(address(0x1000));
        router.deposit(commitments[0]);

        registry.setEligible(address(router), true);
        uint256 root;
        for (uint256 i = 0; i < 8; ++i) {
            address depositor = address(uint160(0x2000 + i));
            token.mint(PARTITION, depositor, DENOMINATION);
            vm.prank(depositor);
            token.approve(address(router), DENOMINATION);
            vm.prank(depositor);
            root = router.deposit(commitments[i]);
        }

        assertEq(token.balanceOfByPartition(PARTITION, address(router)), 8 * DENOMINATION);
        vm.warp(block.timestamp + MINIMUM_DELAY);
        (
            FixedDenominationRouter.ComplianceCiphertext memory ciphertext,
            uint256[8] memory withdrawalSignals,
            uint256[14] memory complianceSignals
        ) = _signals(router, payable(address(recipient)), root, bytes32(uint256(30)));
        _withdraw(
            router,
            payable(address(recipient)),
            ciphertext,
            withdrawalSignals,
            complianceSignals
        );

        assertEq(token.balanceOfByPartition(PARTITION, address(router)), 7 * DENOMINATION);
        assertEq(token.balanceOfByPartition(PARTITION, address(recipient)), DENOMINATION);
        assertEq(router.totalDeposited(), 8 * DENOMINATION);
        assertEq(router.totalWithdrawn(), DENOMINATION);
    }

    function _newLprcRouter(AtsHolds token) internal returns (LprcFixedDenominationRouter) {
        LprcFixedDenominationRouter.Config memory config = LprcFixedDenominationRouter.Config({
            admin: address(this),
            security: IAtsRouterToken(address(token)),
            partition: PARTITION,
            denomination: DENOMINATION,
            minimumWithdrawalDelay: MINIMUM_DELAY,
            maximumRootAge: MAXIMUM_ROOT_AGE,
            minimumRealNotes: 0,
            viewKeyEpoch: VIEW_KEY_EPOCH,
            viewKeyX: VIEW_X,
            viewKeyY: VIEW_Y,
            holdDuration: 1 days
        });
        return new LprcFixedDenominationRouter(
            withdrawalVerifier, complianceVerifier, poseidon, registry, factory, config
        );
    }

    function _proof(string memory path) internal view returns (uint256[24] memory proof) {
        uint256[] memory values = vm.parseJsonUintArray(fixture, path);
        assertEq(values.length, 24);
        for (uint256 i = 0; i < values.length; ++i) {
            proof[i] = values[i];
        }
    }

    function _withdrawalPublic(string memory path)
        internal
        view
        returns (uint256[8] memory publicSignals)
    {
        uint256[] memory values = vm.parseJsonUintArray(fixture, path);
        assertEq(values.length, 8);
        for (uint256 i = 0; i < values.length; ++i) {
            publicSignals[i] = values[i];
        }
    }

    function _compliancePublic(string memory path)
        internal
        view
        returns (uint256[14] memory publicSignals)
    {
        uint256[] memory values = vm.parseJsonUintArray(fixture, path);
        assertEq(values.length, 14);
        for (uint256 i = 0; i < values.length; ++i) {
            publicSignals[i] = values[i];
        }
    }
}
