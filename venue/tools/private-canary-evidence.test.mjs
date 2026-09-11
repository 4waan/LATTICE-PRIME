import assert from "node:assert/strict";
import test from "node:test";

import {
    AbiCoder,
    Interface,
    id,
    keccak256,
} from "ethers";

import {
    QUICKNET_GROUP_HASH,
    QUICKNET_PUBLIC_KEY,
    QUICKNET_SCHEME,
} from "../agent/runtime/drand-client.mjs";
import {
    GAS_GATES,
    QUICKNET_CHAIN_HASH,
    verifyPrivateRelease,
} from "./private-release.mjs";
import {
    PRIVATE_ATS_CANARY_SCHEMA,
    PRIVATE_CANARY_INPUT_SCHEMA,
    PrivateCanaryError,
    buildPrivateCanaryEvidence,
    privateAtsCanaryDigest,
} from "./private-canary-evidence.mjs";

const FACTORY = new Interface([
    "function deploy((address sessionSigner,address recoverySigner,address engine,address security,bytes32 partition,address router,bytes32 quicknetChainHash,uint64 generation,bytes32 feePolicyDigest) config,bytes32 salt) payable returns (address)",
    "event SessionAccountDeployed(address indexed account,bytes32 indexed salt)",
    "event VenueConfigApproval(bytes32 indexed configDigest,bool approved)",
]);
const GATE = new Interface([
    "function registerSession(address account,(uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY) ciphertext,uint256[24] eligibilityProof,uint256[12] eligibilityPublicSignals,uint256[24] complianceProof,uint256[17] compliancePublicSignals)",
    "event SessionRegistered(address indexed account,address indexed sessionSigner,uint64 indexed rotationEpoch,bytes32 sessionSlot,uint64 viewKeyEpoch)",
    "event SessionComplianceRecord(address indexed account,bytes32 indexed sessionSlot,uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)",
]);
const REGISTRY = new Interface([
    "event Granted(address indexed account,uint64 indexed epoch,bytes32 nullifier)",
]);
const SESSION = new Interface([
    "function placeSealed(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound,bytes signature)",
    "function revealAuthorized(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) returns (bytes32)",
]);
const ENGINE = new Interface([
    "function commit(bytes32 id)",
    "function reveal(uint8 side,uint128 price,uint128 qty,bytes32 salt,uint256 backing)",
    "event Committed(bytes32 indexed id,address indexed committer)",
    "event Revealed(bytes32 indexed id,uint8 side,uint128 price,uint128 qty)",
    "event Settled(bytes32 indexed sellId,bytes32 indexed buyId,uint256 amount,uint256 cost)",
]);
const ROUTER = new Interface([
    "function deposit(uint256 commitment) payable returns (uint256)",
    "function withdraw(address recipient,(uint256 encryptedCommitment,uint256 tag,uint256 ephemeralX,uint256 ephemeralY) ciphertext,(uint256[24] withdrawalProof,uint256[8] withdrawalPublicSignals,uint256[24] complianceProof,uint256[14] compliancePublicSignals) bundle)",
    "event Deposited(uint256 indexed commitment,uint32 indexed leafIndex,uint256 indexed root,address depositor,address asset,uint256 denomination,uint64 acceptedAt)",
    "event Withdrawn(bytes32 indexed nullifier,address indexed recipient,uint256 indexed root,address asset,uint256 denomination)",
    "event RouterComplianceRecord(bytes32 indexed nullifier,address indexed recipient,uint64 indexed viewKeyEpoch,uint256 encryptedCommitment,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)",
]);
const LPRC = new Interface([
    "function activateAtsCanary(bytes32 evidenceHash)",
    "event AtsCanaryActivated(bytes32 indexed evidenceHash)",
]);
const ATS = new Interface([
    "event CouponSet(bytes32 indexed corporateActionId,uint256 indexed couponId,address indexed operator,(uint256 recordDate,uint256 executionDate,uint256 startDate,uint256 endDate,uint256 fixingDate,uint256 rate,uint8 rateDecimals,uint8 rateStatus) coupon)",
    "event SnapshotTriggered(uint256 snapshotId,bytes metadata)",
]);
const ATS_HOLDS = new Interface([
    "function createHoldByPartition(bytes32 partition,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) hold) returns (bool success,uint256 holdId)",
    "function createHoldFromByPartition(bytes32 partition,address from,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) hold,bytes operatorData) returns (bool success,uint256 holdId)",
    "function executeHoldByPartition((bytes32 partition,address tokenHolder,uint256 holdId) id,address to,uint256 amount) returns (bool success,bytes32 partition)",
]);

const abiCoder = AbiCoder.defaultAbiCoder();
const RELEASE_AT = 1_692_803_367;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const address = (number) => `0x${BigInt(number).toString(16).padStart(40, "0")}`;
const word = (number) => `0x${BigInt(number).toString(16).padStart(64, "0")}`;
const errorData = (signature, value) =>
    `${id(signature).slice(0, 10)}${BigInt(value).toString(16).padStart(64, "0")}`;

function log(iface, event, args, at) {
    const encoded = iface.encodeEventLog(iface.getEvent(event), args);
    return {address: at, topics: encoded.topics, data: encoded.data};
}

function harness() {
    let transaction = 1n;
    let block = 100;
    const nextReceipt = ({
        to,
        from,
        data = "0x",
        callResult = "0x",
        logs = [],
        gas = 100_000,
        amount = 0,
        at = RELEASE_AT,
        success = true,
        error = "0x",
    }) => ({
        hash: word(transaction++),
        address: to,
        from,
        result: success ? "SUCCESS" : "CONTRACT_REVERT_EXECUTED",
        amount: String(amount),
        gas_used: String(gas),
        block_number: block++,
        timestamp: `${at}.000000001`,
        function_parameters: data,
        call_result: callResult,
        error_message: error,
        logs,
    });
    return {nextReceipt};
}

function makeArtifacts(names) {
    const allowedWrites = [
        "cancelAuthorized",
        "claimCoupon",
        "expire",
        "placeSealed",
        "recoverToRouter",
        "revealAuthorized",
        "sweepEngineCredit",
    ];
    return Object.fromEntries(names.map((name, index) => {
        const code = `0x60${(index + 1).toString(16).padStart(2, "0")}6000`;
        return [name, {
            bytecode: {object: `${code}6001`},
            deployedBytecode: {object: code, immutableReferences: {}},
            abi: name === "CanarySessionAccount"
                ? allowedWrites.map((write) => ({
                    type: "function",
                    name: write,
                    stateMutability: "nonpayable",
                    inputs: [],
                    outputs: [],
                }))
                : [],
        }];
    }));
}

function fixture() {
    const h = harness();
    const names = [
        "CanarySessionAccount",
        "SessionAccountFactory",
        "DualRegistrationGate",
        "HbarRouter",
        "LprcRouter",
        "SessionRecoveryRouter",
        "SessionEligibilityVerifier",
        "SessionComplianceVerifier",
        "FixedWithdrawalVerifier",
        "FixedWithdrawalComplianceVerifier",
    ];
    const artifacts = makeArtifacts(names);
    const addresses = Object.fromEntries(
        names.map((name, index) => [name, address(100 + index)]),
    );
    const poseidon = address(120);
    const engine = address(121);
    const security = address(122);
    const registry = address(123);
    const deployer = address(130);
    const admin = address(131);
    const issuer = address(132);
    const relayer = address(133);
    const wallet = address(134);
    const sessionSigner = address(135);
    const recoverySigner = address(136);
    const executor = address(137);
    const directBuyer = address(138);
    const directSeller = address(139);
    const engineCommitBond = 100n;
    const partition = word(1);
    const feePolicyDigest = word(501);
    const activationEpoch = 7n;
    const sessionRoot = 900n;
    const minTier = 2n;
    const jurisdictionMask = 5n;
    const viewKeyEpoch = 4n;
    const viewKeyX = 901n;
    const viewKeyY = 902n;
    const sessionCreationCodeHash =
        BigInt(keccak256(artifacts.CanarySessionAccount.bytecode.object));
    const hbarDenomination = 100_000_000n;
    const lprcDenomination = 100n;
    const minimumDelay = 30n;
    const maximumAge = 3_600n;
    const runtimeContracts = Object.fromEntries(names.map((name, index) => [
        name,
        {
            evm_address: addresses[name],
            contract_id: `0.0.${1000 + index}`,
            deleted: false,
            runtime_bytecode: artifacts[name].deployedBytecode.object,
        },
    ]));
    const poseidonCode = "0x60016002";

    const venueDigest = keccak256(abiCoder.encode(
        ["address", "address", "bytes32", "address", "bytes32", "bytes32"],
        [
            engine,
            security,
            partition,
            addresses.SessionRecoveryRouter,
            `0x${QUICKNET_CHAIN_HASH}`,
            feePolicyDigest,
        ],
    ));
    const factoryApproval = h.nextReceipt({
        to: addresses.SessionAccountFactory,
        from: deployer,
        logs: [log(
            FACTORY,
            "VenueConfigApproval",
            [venueDigest, true],
            addresses.SessionAccountFactory,
        )],
        at: RELEASE_AT - 1_000,
    });
    const accountConfig = [
        sessionSigner,
        recoverySigner,
        engine,
        security,
        partition,
        addresses.SessionRecoveryRouter,
        `0x${QUICKNET_CHAIN_HASH}`,
        1,
        feePolicyDigest,
    ];
    const sessionDeployment = h.nextReceipt({
        to: addresses.SessionAccountFactory,
        from: deployer,
        data: FACTORY.encodeFunctionData("deploy", [accountConfig, word(700)]),
        logs: [log(
            FACTORY,
            "SessionAccountDeployed",
            [addresses.CanarySessionAccount, word(700)],
            addresses.SessionAccountFactory,
        )],
        at: RELEASE_AT - 999,
    });

    const sessionSlot = word(701);
    const eligibilitySignals = [
        BigInt(sessionSlot),
        1n,
        777n,
        sessionRoot,
        activationEpoch,
        BigInt(addresses.CanarySessionAccount),
        BigInt(sessionSigner),
        BigInt(addresses.SessionAccountFactory),
        sessionCreationCodeHash & ((1n << 128n) - 1n),
        sessionCreationCodeHash >> 128n,
        minTier,
        jurisdictionMask,
    ];
    const complianceSignals = [
        1n,
        2n,
        3n,
        4n,
        eligibilitySignals[2],
        sessionRoot,
        activationEpoch,
        BigInt(addresses.CanarySessionAccount),
        BigInt(sessionSigner),
        BigInt(addresses.SessionAccountFactory),
        eligibilitySignals[8],
        eligibilitySignals[9],
        minTier,
        jurisdictionMask,
        viewKeyEpoch,
        viewKeyX,
        viewKeyY,
    ];
    const registrationReceipt = h.nextReceipt({
        to: addresses.DualRegistrationGate,
        from: relayer,
        data: GATE.encodeFunctionData("registerSession", [
            addresses.CanarySessionAccount,
            [1, 2, 3, 4],
            Array(24).fill(0),
            eligibilitySignals,
            Array(24).fill(0),
            complianceSignals,
        ]),
        logs: [
            log(
                GATE,
                "SessionRegistered",
                [
                    addresses.CanarySessionAccount,
                    sessionSigner,
                    activationEpoch,
                    sessionSlot,
                    viewKeyEpoch,
                ],
                addresses.DualRegistrationGate,
            ),
            log(
                GATE,
                "SessionComplianceRecord",
                [addresses.CanarySessionAccount, sessionSlot, 1, 2, 3, 4],
                addresses.DualRegistrationGate,
            ),
            log(
                REGISTRY,
                "Granted",
                [addresses.CanarySessionAccount, activationEpoch, sessionSlot],
                registry,
            ),
        ],
        at: RELEASE_AT - 900,
        gas: 900_000,
    });

    const atsSource = address(160);
    const atsOperator = address(161);
    const atsOutboundHolder = address(162);
    const atsOutboundRecipient = address(163);
    const atsAmount = lprcDenomination;
    const holdFromReceipt = h.nextReceipt({
        to: security,
        from: atsOperator,
        data: ATS_HOLDS.encodeFunctionData("createHoldFromByPartition", [
            partition,
            atsSource,
            [
                atsAmount,
                RELEASE_AT + 3_600,
                atsOperator,
                addresses.LprcRouter,
                "0x",
            ],
            "0x",
        ]),
        callResult: ATS_HOLDS.encodeFunctionResult(
            "createHoldFromByPartition",
            [true, 41],
        ),
        at: RELEASE_AT - 880,
    });
    const inboundExecutionReceipt = h.nextReceipt({
        to: security,
        from: atsOperator,
        data: ATS_HOLDS.encodeFunctionData("executeHoldByPartition", [
            [partition, atsSource, 41],
            addresses.LprcRouter,
            atsAmount,
        ]),
        callResult: ATS_HOLDS.encodeFunctionResult(
            "executeHoldByPartition",
            [true, partition],
        ),
        at: RELEASE_AT - 879,
    });
    const outboundHoldReceipt = h.nextReceipt({
        to: security,
        from: atsOutboundHolder,
        data: ATS_HOLDS.encodeFunctionData("createHoldByPartition", [
            partition,
            [
                atsAmount,
                RELEASE_AT + 3_600,
                atsOutboundHolder,
                atsOutboundRecipient,
                "0x",
            ],
        ]),
        callResult: ATS_HOLDS.encodeFunctionResult(
            "createHoldByPartition",
            [true, 42],
        ),
        at: RELEASE_AT - 878,
    });
    const outboundExecutionReceipt = h.nextReceipt({
        to: security,
        from: atsOutboundHolder,
        data: ATS_HOLDS.encodeFunctionData("executeHoldByPartition", [
            [partition, atsOutboundHolder, 42],
            atsOutboundRecipient,
            atsAmount,
        ]),
        callResult: ATS_HOLDS.encodeFunctionResult(
            "executeHoldByPartition",
            [true, partition],
        ),
        at: RELEASE_AT - 877,
    });
    const atsCanaryEvidence = {
        schemaVersion: PRIVATE_ATS_CANARY_SCHEMA,
        chainId: 296,
        security,
        pool: addresses.LprcRouter,
        partition,
        source: atsSource,
        operator: atsOperator,
        outboundHolder: atsOutboundHolder,
        outboundRecipient: atsOutboundRecipient,
        amount: atsAmount.toString(),
        holdFromReceipt,
        inboundExecutionReceipt,
        outboundHoldReceipt,
        outboundExecutionReceipt,
    };
    const atsHash = privateAtsCanaryDigest(atsCanaryEvidence);
    const activationReceipt = h.nextReceipt({
        to: addresses.LprcRouter,
        from: admin,
        data: LPRC.encodeFunctionData("activateAtsCanary", [atsHash]),
        logs: [log(
            LPRC,
            "AtsCanaryActivated",
            [atsHash],
            addresses.LprcRouter,
        )],
        at: RELEASE_AT - 800,
    });

    function routingEvidence(kind) {
        const isHbar = kind === "HBAR";
        const pool = isHbar ? addresses.HbarRouter : addresses.LprcRouter;
        const asset = isHbar ? ZERO_ADDRESS : security;
        const denomination = isHbar ? hbarDenomination : lprcDenomination;
        const deposits = [];
        const roots = [];
        for (let index = 0; index < 8; index += 1) {
            const commitment = BigInt(1_000 + (isHbar ? 0 : 100) + index);
            const root = BigInt(2_000 + (isHbar ? 0 : 100) + index);
            const at = RELEASE_AT - 700 + index;
            roots.push(root);
            deposits.push(h.nextReceipt({
                to: pool,
                from: address(200 + index),
                data: ROUTER.encodeFunctionData("deposit", [commitment]),
                logs: [log(
                    ROUTER,
                    "Deposited",
                    [
                        commitment,
                        index,
                        root,
                        address(200 + index),
                        asset,
                        denomination,
                        at,
                    ],
                    pool,
                )],
                at,
                gas: 250_000,
                amount: isHbar ? denomination : 0,
            }));
        }
        const nullifier = word(isHbar ? 3_000 : 3_100);
        const withdrawalSignals = Array(8).fill(0n);
        withdrawalSignals[0] = BigInt(nullifier);
        withdrawalSignals[2] = roots.at(-1);
        withdrawalSignals[3] = BigInt(addresses.CanarySessionAccount);
        withdrawalSignals[4] = BigInt(pool);
        withdrawalSignals[5] = BigInt(asset);
        withdrawalSignals[6] = denomination;
        withdrawalSignals[7] = 296n;
        const complianceSignals = Array(14).fill(0n);
        complianceSignals[0] = 11n;
        complianceSignals[1] = 12n;
        complianceSignals[2] = 13n;
        complianceSignals[3] = 14n;
        complianceSignals[5] = roots.at(-1);
        complianceSignals[6] = BigInt(addresses.CanarySessionAccount);
        complianceSignals[7] = BigInt(pool);
        complianceSignals[8] = BigInt(asset);
        complianceSignals[9] = denomination;
        complianceSignals[10] = 296n;
        complianceSignals[11] = viewKeyEpoch;
        complianceSignals[12] = viewKeyX;
        complianceSignals[13] = viewKeyY;
        const data = ROUTER.encodeFunctionData("withdraw", [
            addresses.CanarySessionAccount,
            [11, 12, 13, 14],
            [
                Array(24).fill(0),
                withdrawalSignals,
                Array(24).fill(0),
                complianceSignals,
            ],
        ]);
        const withdrawal = h.nextReceipt({
            to: pool,
            from: relayer,
            data,
            logs: [log(
                ROUTER,
                "Withdrawn",
                [
                    nullifier,
                    addresses.CanarySessionAccount,
                    roots.at(-1),
                    asset,
                    denomination,
                ],
                pool,
            ), log(
                ROUTER,
                "RouterComplianceRecord",
                [
                    nullifier,
                    addresses.CanarySessionAccount,
                    viewKeyEpoch,
                    11,
                    12,
                    13,
                    14,
                ],
                pool,
            )],
            at: RELEASE_AT - 650,
            gas: 500_000,
        });
        const replay = h.nextReceipt({
            to: pool,
            from: relayer,
            data,
            logs: [],
            at: RELEASE_AT - 649,
            gas: 80_000,
            success: false,
            error: errorData("NullifierAlreadySpent(bytes32)", BigInt(nullifier)),
        });
        return {
            deposits,
            withdrawal,
            replay,
            accounting: {
                before: {
                    blockNumber: Math.min(...deposits.map((row) => row.block_number)) - 1,
                    totalDeposited: "0",
                    totalWithdrawn: "0",
                    assetBalance: "0",
                },
                after: {
                    blockNumber: replay.block_number,
                    totalDeposited: (8n * denomination).toString(),
                    totalWithdrawn: denomination.toString(),
                    assetBalance: (7n * denomination).toString(),
                },
            },
        };
    }

    const HBAR = routingEvidence("HBAR");
    const LPRC_ROUTING = routingEvidence("LPRC");
    const couponSetReceipt = h.nextReceipt({
        to: security,
        from: issuer,
        logs: [log(
            ATS,
            "CouponSet",
            [
                word(4_000),
                1,
                issuer,
                [RELEASE_AT - 600, RELEASE_AT - 500, RELEASE_AT - 700,
                    RELEASE_AT - 500, RELEASE_AT - 600, 500, 4, 1],
            ],
            security,
        )],
        at: RELEASE_AT - 600,
        gas: 700_000,
    });
    const snapshotReceipt = h.nextReceipt({
        to: security,
        from: issuer,
        logs: [log(ATS, "SnapshotTriggered", [9, "0x"], security)],
        at: RELEASE_AT - 500,
        gas: 600_000,
    });

    const pathReceipts = {};
    function privatePath(side, kind, sequence, privateGas) {
        const sideValue = side === "buy" ? 0 : 1;
        const commitment = word(5_000 + sequence);
        const envelope = word(6_000 + sequence);
        const order = commitment;
        const revealData = SESSION.encodeFunctionData("revealAuthorized", [
            sideValue,
            100 + sequence,
            10,
            word(8_000 + sequence),
            envelope,
            1,
        ]);
        const place = h.nextReceipt({
            to: addresses.CanarySessionAccount,
            from: relayer,
            data: SESSION.encodeFunctionData("placeSealed", [
                commitment,
                envelope,
                1,
                `0x${"01".repeat(65)}`,
            ]),
            logs: [log(
                ENGINE,
                "Committed",
                [commitment, addresses.CanarySessionAccount],
                engine,
            )],
            at: RELEASE_AT - 50,
            gas: 200_000,
        });
        const earlyReveal = h.nextReceipt({
            to: addresses.CanarySessionAccount,
            from: relayer,
            data: revealData,
            at: RELEASE_AT - 1,
            gas: 100_000,
            success: false,
            error: errorData("TimedReleasePending(uint64)", RELEASE_AT),
        });
        const reveal = h.nextReceipt({
            to: addresses.CanarySessionAccount,
            from: relayer,
            data: revealData,
            logs: [log(
                ENGINE,
                "Revealed",
                [order, sideValue, 100 + sequence, 10],
                engine,
            )],
            at: RELEASE_AT,
            gas: privateGas - 200_000n,
        });
        const settlement = h.nextReceipt({
            to: engine,
            from: executor,
            logs: [log(
                ENGINE,
                "Settled",
                side === "buy"
                    ? [word(9_000 + sequence), order, 10, 1_000]
                    : [order, word(9_000 + sequence), 10, 1_000],
                engine,
            )],
            at: RELEASE_AT + 1,
            gas: 800_000,
        });
        pathReceipts[`${side}.${kind}`] = {place, earlyReveal, reveal, settlement};
        return pathReceipts[`${side}.${kind}`];
    }

    function directControl(side, sequence, gas) {
        const sideValue = side === "buy" ? 0 : 1;
        const caller = side === "buy" ? directBuyer : directSeller;
        const salt = word(10_000 + sequence);
        const orderId = keccak256(AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "uint8", "uint128", "uint128", "bytes32"],
            [id("hedera2026.orderbook.v1"), caller, sideValue, 100, 10, salt],
        ));
        const commitGas = 100_000n;
        const reservationGas = side === "sell" ? 200_000n : 0n;
        const commit = h.nextReceipt({
            to: engine,
            from: caller,
            data: ENGINE.encodeFunctionData("commit", [orderId]),
            logs: [log(ENGINE, "Committed", [orderId, caller], engine)],
            at: RELEASE_AT - 2,
            gas: commitGas,
            amount: engineCommitBond,
        });
        const holdId = BigInt(20_000 + sequence);
        const reservation = side === "sell" ? h.nextReceipt({
            to: security,
            from: caller,
            data: ATS_HOLDS.encodeFunctionData("createHoldByPartition", [
                partition,
                [10, RELEASE_AT + 1_000, engine, address(0), "0x"],
            ]),
            callResult: ATS_HOLDS.encodeFunctionResult(
                "createHoldByPartition",
                [true, holdId],
            ),
            at: RELEASE_AT - 3,
            gas: reservationGas,
        }) : null;
        const reveal = h.nextReceipt({
            to: engine,
            from: caller,
            data: ENGINE.encodeFunctionData("reveal", [
                sideValue,
                100,
                10,
                salt,
                sideValue === 0 ? 0 : holdId,
            ]),
            logs: [log(
                ENGINE,
                "Revealed",
                [orderId, sideValue, 100, 10],
                engine,
            )],
            at: RELEASE_AT,
            gas: gas - commitGas - reservationGas,
            amount: side === "buy" ? 1_000 : 0,
        });
        return side === "sell" ? {reservation, commit, reveal} : {commit, reveal};
    }

    const buyFresh = privatePath("buy", "fresh", 1, GAS_GATES.buy.target);
    const buyRepeated = privatePath("buy", "repeated", 2, GAS_GATES.buy.target);
    const sellFresh = privatePath("sell", "fresh", 3, GAS_GATES.sell.target);
    const sellRepeated = privatePath("sell", "repeated", 4, GAS_GATES.sell.target);
    const buyDirectFresh = directControl("buy", 1, GAS_GATES.buy.direct);
    const buyDirectRepeated = directControl("buy", 2, GAS_GATES.buy.direct);
    const sellDirectFresh = directControl("sell", 3, GAS_GATES.sell.direct);
    const sellDirectRepeated = directControl("sell", 4, GAS_GATES.sell.direct);
    const rollbackReceipt = h.nextReceipt({
        to: addresses.CanarySessionAccount,
        from: relayer,
        data: sellRepeated.reveal.function_parameters,
        at: RELEASE_AT + 2,
        gas: 150_000,
        success: false,
        error: errorData("AlreadyRevealed(bytes32)", 5_004),
    });

    const input = {
        schemaVersion: PRIVATE_CANARY_INPUT_SCHEMA,
        deployment: {
            candidateOnly: true,
            network: {chainId: 296},
            roles: {deployer, admin, issuer, relayer},
            addresses,
            contracts: runtimeContracts,
            poseidonContract: {
                evm_address: poseidon,
                contract_id: "0.0.2000",
                deleted: false,
                runtime_bytecode: poseidonCode,
            },
            context: {
                engine,
                security,
                registry,
                poseidon2: poseidon,
                poseidon2RuntimeCodeHash: keccak256(poseidonCode),
                partition,
                feePolicyDigest,
                quicknetChainHash: `0x${QUICKNET_CHAIN_HASH}`,
                generation: "1",
                activationEpoch: activationEpoch.toString(),
                sessionRoot: sessionRoot.toString(),
                minTier: minTier.toString(),
                jurisdictionMask: jurisdictionMask.toString(),
                hbarDenominationTinybar: hbarDenomination.toString(),
                lprcDenomination: lprcDenomination.toString(),
                minimumWithdrawalDelay: minimumDelay.toString(),
                maximumRootAge: maximumAge.toString(),
                minimumRealNotes: "8",
                viewKeyEpoch: viewKeyEpoch.toString(),
                viewKeyX: viewKeyX.toString(),
                viewKeyY: viewKeyY.toString(),
                engineRevealDelay: "30",
                engineRevealWindow: "270",
            },
            receipts: {factoryApproval, sessionDeployment},
        },
        session: {
            sessionSigner,
            recoverySigner,
            registrationReceipt,
        },
        routing: {HBAR, LPRC: LPRC_ROUTING},
        lprcLifecycle: {
            activationReceipt,
            atsCanaryEvidence,
            coupon: {
                couponSetReceipt,
                snapshotReceipt,
                observation: {
                    holder: addresses.LprcRouter,
                    balanceAtRecord: lprcDenomination.toString(),
                    couponAmount: "1",
                    couponId: "1",
                    snapshotId: "9",
                },
            },
        },
        canaries: {
            connectedWallet: wallet,
            relayer,
            directBuyer,
            directSeller,
            engineCommitBond: engineCommitBond.toString(),
            engineRevealDelay: "30",
            engineRevealWindow: "270",
            buy: {
                fresh: buyFresh,
                repeated: buyRepeated,
                directFresh: buyDirectFresh,
                directRepeated: buyDirectRepeated,
                measurementWindow: {
                    startsAt: String(RELEASE_AT - 60),
                    endsAt: String(RELEASE_AT + 5),
                },
            },
            sell: {
                fresh: sellFresh,
                repeated: sellRepeated,
                directFresh: sellDirectFresh,
                directRepeated: sellDirectRepeated,
                measurementWindow: {
                    startsAt: String(RELEASE_AT - 60),
                    endsAt: String(RELEASE_AT + 5),
                },
                rollback: {
                    failedReveal: rollbackReceipt,
                    before: {
                        blockNumber: rollbackReceipt.block_number - 1,
                        sessionTokenBalance: "100",
                        engineRevealedCount: "4",
                        tokenTotalHolds: "2",
                        nextHoldId: "3",
                    },
                    after: {
                        blockNumber: rollbackReceipt.block_number,
                        sessionTokenBalance: "100",
                        engineRevealedCount: "4",
                        tokenTotalHolds: "2",
                        nextHoldId: "3",
                    },
                },
            },
        },
        service: {
            paths: {
                tickets: "/api/private/tickets",
                orders: "/api/private/orders",
                routing: "/api/private/routing",
                sessions: "/api/private/sessions",
            },
            quicknet: {
                info: {
                    public_key: QUICKNET_PUBLIC_KEY,
                    period: 3,
                    genesis_time: RELEASE_AT,
                    hash: QUICKNET_CHAIN_HASH,
                    groupHash: QUICKNET_GROUP_HASH,
                    schemeID: QUICKNET_SCHEME,
                },
                beacons: [{
                    round: 1,
                    randomness:
                        "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
                    signature:
                        "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
                }],
                relayAttempts: [
                    {
                        url: `https://api.drand.sh/${QUICKNET_CHAIN_HASH}/public/1`,
                        outcome: "FAILED",
                    },
                    {
                        url: `https://drand.cloudflare.com/${QUICKNET_CHAIN_HASH}/public/1`,
                        outcome: "SUCCESS",
                    },
                ],
            },
            crashRecovery: {
                before: {
                    ticketId: "12".repeat(32),
                    byteDigest: `sha256:${"34".repeat(32)}`,
                    instanceId: "worker-one",
                    state: "DECRYPTING",
                    revision: "3",
                },
                crash: {
                    ticketId: "12".repeat(32),
                    byteDigest: `sha256:${"34".repeat(32)}`,
                    instanceId: "worker-one",
                    state: "DECRYPTING",
                    revision: "3",
                    code: "SIMULATED_CRASH",
                },
                after: {
                    ticketId: "12".repeat(32),
                    byteDigest: `sha256:${"34".repeat(32)}`,
                    instanceId: "worker-two",
                    state: "REVEALED",
                    revision: "5",
                    transactionHash: buyRepeated.reveal.hash,
                },
            },
            logCapture: {
                lines: [
                    "WORKER_STARTED ticket=public",
                    "SIMULATED_CRASH code=SIMULATED_CRASH",
                    "REVEALED status=CONFIRMED",
                ],
                lineCount: 3,
                sentinels: [
                    "private-capability-1234",
                    "private-random-salt-5678",
                    "private-order-price-9012",
                ],
            },
        },
        provingArtifacts: Object.fromEntries(
            [
                "sessionEligibility",
                "sessionCompliance",
                "routingWithdrawal",
                "routingCompliance",
            ].map((name, index) => [name, {
                wasm: {
                    url: `/private-artifacts/${name}.wasm`,
                    bytes: 1_000 + index,
                    sha256: `0x${"12".repeat(32)}`,
                },
                zkey: {
                    url: `/private-artifacts/${name}.zkey`,
                    bytes: 2_000 + index,
                    sha256: `0x${"34".repeat(32)}`,
                },
                verificationKey: {protocol: "plonk", curve: "bn128"},
            }]),
        ),
    };
    return {
        input,
        artifacts,
        wallet,
        interfaces: {SESSION, ROUTER},
    };
}

test("real receipt fields derive a releasable candidate", () => {
    const {input, artifacts} = fixture();
    const candidate = buildPrivateCanaryEvidence(input, {
        contractArtifacts: artifacts,
    });
    assert.equal(candidate.candidateOnly, true);
    assert.equal(candidate.network.chainId, 296);
    assert.equal(candidate.routing.HBAR.independentNotes, 8);
    assert.equal(candidate.routing.LPRC.independentFunders, 8);
    assert.equal(candidate.addresses.CanarySessionAccount, undefined);
    assert.equal(candidate.runtimeCodeHashes.CanarySessionAccount, undefined);
    assert.equal(
        candidate.session.canaryAccount,
        input.deployment.addresses.CanarySessionAccount.toLowerCase(),
    );
    assert.match(candidate.session.canaryRuntimeCodeHash, /^0x[0-9a-f]{64}$/);
    assert.match(candidate.session.creationCodeHash, /^0x[0-9a-f]{64}$/);
    assert.equal(candidate.gas.buy.privateWarm, GAS_GATES.buy.target.toString());
    assert.equal(candidate.gas.sell.privateWarm, GAS_GATES.sell.target.toString());
    assert.equal(candidate.gas.buy.directWarm, GAS_GATES.buy.direct.toString());
    assert.equal(candidate.gas.sell.directWarm, GAS_GATES.sell.direct.toString());
    for (const category of [
        "setup",
        "routing",
        "rotation",
        "recovery",
        "earlyRefusal",
        "settlement",
    ]) {
        assert.ok(BigInt(candidate.gasExcluded[category].total) > 0n);
        assert.ok(candidate.gasExcluded[category].components.length > 0);
    }
    const clientGate = verifyPrivateRelease(candidate);
    assert.equal(clientGate.enabled, true);
    assert.equal(clientGate.gasObserved.buy, GAS_GATES.buy.target.toString());
    assert.equal(clientGate.gasObserved.sell, GAS_GATES.sell.target.toString());
    assert.equal(clientGate.gasDirectObserved.buy, GAS_GATES.buy.direct.toString());
    assert.equal(clientGate.gasDirectObserved.sell, GAS_GATES.sell.direct.toString());
    assert.equal(clientGate.addresses.CanarySessionAccount, undefined);
    assert.equal(
        clientGate.session.creationCodeHash,
        candidate.session.creationCodeHash,
    );
});

test("caller booleans cannot override a failed or wrong-context receipt", () => {
    const {input, artifacts} = fixture();
    input.assertions = {
        timedReleasePassed: true,
        walletPrivacyPassed: true,
        routerThresholdPassed: true,
    };
    input.canaries.buy.fresh.earlyReveal.result = "SUCCESS";
    input.canaries.buy.fresh.earlyReveal.status = "0x1";
    assert.throws(
        () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
        (error) => error instanceof PrivateCanaryError
            && error.code === "REFUSAL_MISSING",
    );
});

test("wallet bytes in sealed placement calldata fail privacy", () => {
    const {input, artifacts, wallet} = fixture();
    const original = SESSION.parseTransaction({
        data: input.canaries.buy.fresh.place.function_parameters,
    });
    input.canaries.buy.fresh.place.function_parameters =
        SESSION.encodeFunctionData("placeSealed", [
            original.args[0],
            original.args[1],
            original.args[2],
            `0x${wallet.slice(2)}${"01".repeat(45)}`,
        ]);
    assert.throws(
        () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
        (error) => error.code === "PRIVACY_CALLDATA_FAILED"
            && error.section === "buy",
    );
});

test("gas, funding diversity, runtime, and rollback checks fail independently", () => {
    const cases = [
        {
            code: "GAS_HARD_CAP",
            mutate(input) {
                input.canaries.sell.repeated.reveal.gas_used =
                    (GAS_GATES.sell.cap + 1n).toString();
            },
        },
        {
            code: "ANONYMITY_THRESHOLD",
            mutate(input) {
                const first = input.routing.HBAR.deposits[0];
                const last = input.routing.HBAR.deposits[7];
                last.from = first.from;
                const parsed = ROUTER.parseLog(last.logs[0]);
                last.logs[0] = log(
                    ROUTER,
                    "Deposited",
                    [
                        parsed.args.commitment,
                        parsed.args.leafIndex,
                        parsed.args.root,
                        first.from,
                        parsed.args.asset,
                        parsed.args.denomination,
                        parsed.args.acceptedAt,
                    ],
                    last.address,
                );
            },
        },
        {
            code: "RUNTIME_ARTIFACT_MISMATCH",
            mutate(input) {
                input.deployment.contracts.CanarySessionAccount.runtime_bytecode =
                    "0x60006000";
            },
        },
        {
            code: "SELL_ROLLBACK_FAILED",
            mutate(input) {
                input.canaries.sell.rollback.after.nextHoldId = "4";
            },
        },
        {
            code: "ATS_EVIDENCE_INVALID",
            mutate(input) {
                input.lprcLifecycle.atsCanaryEvidence
                    .holdFromReceipt.call_result =
                        ATS_HOLDS.encodeFunctionResult(
                            "createHoldFromByPartition",
                            [false, 41],
                        );
            },
        },
        {
            code: "TIMED_RELEASE_INVALID",
            mutate(input) {
                input.canaries.buy.fresh.earlyReveal.timestamp =
                    `${RELEASE_AT - 60}.000000001`;
            },
        },
        {
            code: "ROUTER_CONTEXT_MISMATCH",
            mutate(input) {
                input.routing.HBAR.deposits[0].amount =
                    (100_000_000n * 10_000_000_000n).toString();
            },
        },
    ];
    for (const {code, mutate} of cases) {
        const {input, artifacts} = fixture();
        mutate(input);
        assert.throws(
            () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
            (error) => error.code === code,
            code,
        );
    }
});

test("whole-path gas evidence rejects missing and duplicated components", () => {
    for (const mutate of [
        (input) => {
            delete input.canaries.buy.directFresh.commit;
        },
        (input) => {
            input.canaries.buy.directRepeated.commit =
                input.canaries.buy.directFresh.commit;
        },
        (input) => {
            delete input.canaries.sell.directFresh.reservation;
        },
        (input) => {
            delete input.canaries.buy.fresh.place;
        },
    ]) {
        const {input, artifacts} = fixture();
        mutate(input);
        assert.throws(
            () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
            (error) => [
                "INPUT_INVALID",
                "RECEIPT_INVALID",
                "GAS_CONTROL_MISMATCH",
            ].includes(error.code),
        );
    }
});

test("direct sell reservation must precede commit and reveal", () => {
    const {input, artifacts} = fixture();
    const path = input.canaries.sell.directFresh;
    const reservationTimestamp = path.reservation.timestamp;
    path.reservation.timestamp = path.commit.timestamp;
    path.commit.timestamp = reservationTimestamp;
    assert.throws(
        () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
        (error) => error.code === "GAS_CONTROL_MISMATCH",
    );
});

test("whole-path gas evidence rejects wrong callers and reveal-only totals", () => {
    {
        const {input, artifacts} = fixture();
        input.canaries.buy.directFresh.commit.from = address(199);
        assert.throws(
            () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
            (error) => error.code === "GAS_CONTROL_MISMATCH",
        );
    }
    {
        const {input, artifacts} = fixture();
        input.canaries.sell.directFresh.reveal.gas_used =
            GAS_GATES.sell.direct.toString();
        assert.throws(
            () => buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts}),
            (error) => error.code === "GAS_BASELINE_MISMATCH",
        );
    }
});
