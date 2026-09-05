// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IAtsFactory, IAtsTypes, IAtsToken} from "./ats/IAtsFactory.sol";

/// @title DeployAtsBond
/// @notice Issues the collateral the venue trades: a real ATS bond, deployed by
///         the Asset Tokenization Studio factory Hashgraph itself runs on Hedera
///         testnet, with `ZkKycRegistry` installed as its external KYC list.
///
/// ## Why the published factory and not a fresh one
///
/// The repo can deploy its own resolver and factory; `deploy:newBlr:hedera:testnet`
/// does exactly that, and the June 2026 run of it cost 180 million gas across
/// twenty eight minutes. Doing that again would produce a private copy of ATS
/// that only this project uses. Using the deployment Hashgraph published is the
/// stronger claim and the cheaper one: the token below is a diamond over the
/// same 108 facets every other ATS token on testnet resolves against, and the
/// venue is a counterparty to it rather than its author.
///
///   resolver  0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a  (0.0.9212226)
///   factory   0xd1F118A40f3b02883D35909eF2517e7EDd78379d  (0.0.9213391)
///
/// Both were read back live before this script was written. `SeamMap` is
/// generated from v8.0.0 be4f860, which is the tag that deployment was cut from,
/// so the 102 rows the census asserts over are rows of *this* token.
///
/// ## Four configuration choices that are the whole point
///
/// **`internalKycActivated = false`.** `KycStorageWrapper.verifyKycStatus`
/// reads `!internalKycActivated || <internal check>` and then ANDs the external
/// lists unconditionally. Turning the internal register off does not weaken the
/// gate, it removes the *other* gate, which leaves `ZkKycRegistry` as the only
/// thing standing between an address and this bond. That is the project's claim
/// stated as a deployment parameter: a proof of eligibility, and no register of
/// who is eligible.
///
/// **`compliance = address(0)`, set afterwards.** `SeamJournal.token` is
/// immutable and is the write side's only accepted caller, so the journal cannot
/// be built before the token has an address, and the token cannot name the
/// journal before the journal exists. The factory calls `initializeCompliance`
/// unconditionally, which spends the one-shot; `setCompliance` under
/// `ROLE_TREX_OWNER` is the supported second write, so the cycle is broken on
/// the token's side rather than by predicting an address.
///
/// **`identityRegistry = address(0)`.** Seam E in `SeamMap`. This venue does not
/// implement `IIdentityRegistry` and will not pretend to: ATS reads a zero
/// registry as "not consulted", and a stub returning `true` would be a seam the
/// census counts and nothing enforces.
///
/// **`isMultiPartition = false`.** `createHoldByPartition` carries
/// `onlyDefaultPartitionWithSinglePartition`, and the venue's partition constant
/// is already `bytes32(uint256(1))`, which is ATS's `_DEFAULT_PARTITION`. The
/// two agreed by accident; this pins them.
///
/// Reg S with no sub-type, because `_isValidTypeAndSubType` admits only Reg S
/// alone or Reg D with 506(b) or 506(c), and an offshore offering is the honest
/// one of the three for a venue whose circuit carries a jurisdiction mask.
contract DeployAtsBond is Script {
    // ------------------------------------------------- the published deployment

    address internal constant RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;
    address internal constant FACTORY = 0xd1F118A40f3b02883D35909eF2517e7EDd78379d;
    /// @dev `configurations.bond.configId` from newBlr-2026-06-12, version 1.
    bytes32 internal constant BOND_CONFIG = bytes32(uint256(2));
    uint256 internal constant BOND_VERSION = 1;

    // ------------------------------------------------------------------- roles

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant ROLE_ISSUER = 0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    bytes32 internal constant ROLE_TREX_OWNER = 0xd9e1264632ee9a37e8673a0c55a0a1d8b38c758e843084168ee08cd2d1f7e6f0;
    bytes32 internal constant ROLE_KYC_MANAGER = 0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e;
    bytes32 internal constant ROLE_CONTROLLER = 0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e;
    bytes32 internal constant ROLE_PAUSER = 0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f;
    bytes32 internal constant ROLE_CAP = 0x58d502b7184e1a264e0cacf1a19a6c268356c6d9fda5ad83ab3b599cd3b7f41c;

    // -------------------------------------------------------------- instrument

    /// @dev Twelve characters with a valid ISO 6166 check digit, because
    ///      `_validateISIN` computes one and refuses anything else. XS is the
    ///      international prefix; the body names the venue rather than borrowing
    ///      a real issuer's identifier.
    string internal constant ISIN = "XS0SEAMME017";
    bytes3 internal constant CURRENCY = 0x555344; // "USD"
    uint256 internal constant NOMINAL = 10_000; // 100.00
    uint8 internal constant NOMINAL_DECIMALS = 2;
    uint256 internal constant TENOR = 730 days;

    /// @dev Not zero, and the reason is a discrepancy worth recording. Upstream's
    ///      `SecurityData` docstring says "0 means unlimited" for `maxSupply`;
    ///      the bond configuration's `initializeCap` reverts
    ///      `NewMaxSupplyCannotBeZero()` on exactly that value. The dry run
    ///      found it before a transaction was spent. One million units at a
    ///      nominal of 100.00 is a hundred million of notional, which is a
    ///      plausible size for a single collateral line and small enough that
    ///      the cap is a real bound rather than a formality.
    uint256 internal constant MAX_SUPPLY = 1_000_000;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);
        address registry = vm.envAddress("ZK_KYC_REGISTRY");

        IAtsTypes.Rbac[] memory rbacs = _rbacs(me);

        address[] memory kycLists = new address[](1);
        kycLists[0] = registry;

        IAtsTypes.SecurityData memory security = IAtsTypes.SecurityData({
            resolver: RESOLVER,
            maxSupply: MAX_SUPPLY,
            resolverProxyConfiguration: IAtsTypes.ResolverProxyConfiguration({
                key: BOND_CONFIG,
                version: BOND_VERSION
            }),
            erc20MetadataInfo: IAtsTypes.ERC20MetadataInfo({
                name: "SeamMe Repo Collateral 2028",
                symbol: "SEAMC",
                isin: ISIN,
                decimals: 0
            }),
            rbacs: rbacs,
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
                nominalValue: NOMINAL,
                nominalValueDecimals: NOMINAL_DECIMALS,
                startingDate: block.timestamp,
                maturityDate: block.timestamp + TENOR
            }),
            proceedRecipients: new address[](0),
            proceedRecipientsData: new bytes[](0)
        });

        IAtsTypes.FactoryRegulationData memory reg = IAtsTypes.FactoryRegulationData({
            regulationType: IAtsTypes.RegulationType.REG_S,
            regulationSubType: IAtsTypes.RegulationSubType.NONE,
            additionalSecurityData: IAtsTypes.AdditionalSecurityData({
                countriesControlListType: false,
                listOfCountries: "",
                info: "SeamMe testnet repo collateral. Eligibility is proved, not registered."
            })
        });

        vm.startBroadcast(pk);
        address token = IAtsFactory(FACTORY).deployBond(bond, reg);
        vm.stopBroadcast();

        console2.log("bond token       ", token);
        console2.log("resolver         ", RESOLVER);
        console2.log("factory          ", FACTORY);
        console2.log("external kyc list", registry);
        console2.log("maturity         ", block.timestamp + TENOR);
    }

    /// @dev `onlyValidAdmins` requires a non-zero `DEFAULT_ADMIN_ROLE` member,
    ///      and the factory renounces its own admin role on the way out, so
    ///      every power over this token has to be seated here or it is seated
    ///      nowhere. The operator holds them all on testnet, which is a
    ///      deployment fact and not a design one: the roles are distinct in ATS
    ///      and the venue holds none of them.
    function _rbacs(address me) internal pure returns (IAtsTypes.Rbac[] memory rbacs) {
        bytes32[7] memory roles = [
            DEFAULT_ADMIN_ROLE,
            ROLE_ISSUER,
            ROLE_TREX_OWNER,
            ROLE_KYC_MANAGER,
            ROLE_CONTROLLER,
            ROLE_PAUSER,
            ROLE_CAP
        ];
        rbacs = new IAtsTypes.Rbac[](roles.length);
        for (uint256 i = 0; i < roles.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = me;
            rbacs[i] = IAtsTypes.Rbac({role: roles[i], members: members});
        }
    }
}
