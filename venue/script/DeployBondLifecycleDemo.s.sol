// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CouponDistributor} from "../src/coupon/CouponDistributor.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {ICashToken} from "../src/interfaces/ICashToken.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";
import {IAtsFactory, IAtsTypes} from "./ats/IAtsFactory.sol";

/// @title DeployBondLifecycleDemo
/// @notice Deploys a separate compressed-clock ATS bond and its paying leg.
/// @dev This deployment is evidence-only. It never replaces the canonical LPRC
///      address or any contract in deployments/client.json.
contract DeployBondLifecycleDemo is Script {
    address internal constant RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;
    address internal constant FACTORY = 0xd1F118A40f3b02883D35909eF2517e7EDd78379d;
    bytes32 internal constant BOND_CONFIG = bytes32(uint256(2));
    uint256 internal constant BOND_VERSION = 1;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant ROLE_ISSUER =
        0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    bytes32 internal constant ROLE_TREX_OWNER =
        0xd9e1264632ee9a37e8673a0c55a0a1d8b38c758e843084168ee08cd2d1f7e6f0;
    bytes32 internal constant ROLE_KYC_MANAGER =
        0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e;
    bytes32 internal constant ROLE_CONTROLLER =
        0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e;
    bytes32 internal constant ROLE_PAUSER =
        0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f;
    bytes32 internal constant ROLE_CAP =
        0x58d502b7184e1a264e0cacf1a19a6c268356c6d9fda5ad83ab3b599cd3b7f41c;
    bytes32 internal constant ROLE_CORPORATE_ACTION =
        0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd;
    bytes32 internal constant ROLE_MATURITY_REDEEMER =
        0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523;

    uint256 public constant MAX_SUPPLY = 1_000_000;
    uint64 public constant COUPON_DELAY = 20 minutes;
    uint64 public constant RECORD_LEAD = 5 minutes;
    uint64 public constant MATURITY_DELAY = 30 minutes;
    uint64 public constant CLAIM_WINDOW = 30 days;
    uint16 public constant SPREAD_BPS = 75;
    uint128 public constant FACE_VALUE = 10_000;
    uint256 public constant PAYING_AGENT_FEE_BPS = 25;

    string internal constant ISIN = "XS0LPRDEMO10";
    bytes3 internal constant CURRENCY = 0x555344;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);
        address registry = vm.envAddress("ZK_KYC_REGISTRY");
        IDisclosurePolicy policy = IDisclosurePolicy(vm.envAddress("VENUE_PARAMS"));
        ICashToken cash = ICashToken(vm.envAddress("CASH_TOKEN"));

        uint64 issuedAt = uint64(block.timestamp);
        uint64 couponDue = issuedAt + COUPON_DELAY;
        uint64 maturity = issuedAt + MATURITY_DELAY;

        vm.startBroadcast(pk);
        address token = _deployBond(me, registry, issuedAt, maturity);
        CouponSchedule schedule = _deploySchedule(issuedAt, couponDue);
        CouponDistributor distributor = new CouponDistributor(
            policy, schedule, cash, me, CLAIM_WINDOW, PAYING_AGENT_FEE_BPS
        );
        vm.stopBroadcast();

        console2.log("demoBond             ", token);
        console2.log("demoCouponSchedule   ", address(schedule));
        console2.log("demoCouponDistributor", address(distributor));
        console2.log("issuedAt             ", issuedAt);
        console2.log("recordDate           ", couponDue - RECORD_LEAD);
        console2.log("couponDue            ", couponDue);
        console2.log("maturity             ", maturity);
        console2.log("productionBinding    ", false);
    }

    function _deployBond(address me, address registry, uint64 issuedAt, uint64 maturity)
        private
        returns (address token)
    {
        address[] memory kycLists = new address[](1);
        kycLists[0] = registry;
        IAtsTypes.SecurityData memory security = IAtsTypes.SecurityData({
            resolver: RESOLVER,
            maxSupply: MAX_SUPPLY,
            resolverProxyConfiguration: IAtsTypes.ResolverProxyConfiguration({
                key: BOND_CONFIG, version: BOND_VERSION
            }),
            erc20MetadataInfo: IAtsTypes.ERC20MetadataInfo({
                name: "Lattice Prime Lifecycle Demo Bond",
                symbol: "LPLD",
                isin: ISIN,
                decimals: 0
            }),
            rbacs: _rbacs(me),
            externalPauses: new address[](0),
            externalControlLists: new address[](0),
            externalKycLists: kycLists,
            compliance: address(0),
            identityRegistry: address(0),
            arePartitionsProtected: false,
            isMultiPartition: false,
            isControllable: true,
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: false,
            erc20VotesActivated: false
        });
        IAtsTypes.BondData memory bond = IAtsTypes.BondData({
            security: security,
            bondDetails: IAtsTypes.BondDetailsData({
                currency: CURRENCY,
                nominalValue: FACE_VALUE,
                nominalValueDecimals: 2,
                startingDate: issuedAt,
                maturityDate: maturity
            }),
            proceedRecipients: new address[](0),
            proceedRecipientsData: new bytes[](0)
        });
        IAtsTypes.FactoryRegulationData memory regulation = IAtsTypes.FactoryRegulationData({
            regulationType: IAtsTypes.RegulationType.REG_S,
            regulationSubType: IAtsTypes.RegulationSubType.NONE,
            additionalSecurityData: IAtsTypes.AdditionalSecurityData({
                countriesControlListType: false,
                listOfCountries: "",
                info: "Compressed testnet lifecycle evidence. No production binding."
            })
        });
        token = IAtsFactory(FACTORY).deployBond(bond, regulation);
    }

    function _deploySchedule(uint64 issuedAt, uint64 couponDue)
        private
        returns (CouponSchedule schedule)
    {
        uint64[] memory dates = new uint64[](1);
        dates[0] = couponDue;
        schedule = new CouponSchedule(
            issuedAt, dates, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365
        );
    }

    function _rbacs(address me) private pure returns (IAtsTypes.Rbac[] memory rbacs) {
        bytes32[9] memory roles = [
            DEFAULT_ADMIN_ROLE,
            ROLE_ISSUER,
            ROLE_TREX_OWNER,
            ROLE_KYC_MANAGER,
            ROLE_CONTROLLER,
            ROLE_PAUSER,
            ROLE_CAP,
            ROLE_CORPORATE_ACTION,
            ROLE_MATURITY_REDEEMER
        ];
        rbacs = new IAtsTypes.Rbac[](roles.length);
        for (uint256 i = 0; i < roles.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = me;
            rbacs[i] = IAtsTypes.Rbac({role: roles[i], members: members});
        }
    }
}
