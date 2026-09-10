// SPDX-License-Identifier: BUSL-1.1
// VENDORED from hashgraph/asset-tokenization-studio v8.0.0 be4f860, Apache-2.0.
// Sources: packages/ats/contracts/contracts/factory/IFactory.sol
//          packages/ats/contracts/contracts/constants/regulation.sol
//          packages/ats/contracts/contracts/facets/core/ICore.sol
//          packages/ats/contracts/contracts/infrastructure/proxy/IResolverProxy.sol
//          packages/ats/contracts/contracts/facets/accessControl/IAccessControl.sol
//          packages/ats/contracts/contracts/facets/compliance/IComplianceFacet.sol
//          packages/ats/contracts/contracts/facets/mint/IMint.sol
//          packages/ats/contracts/contracts/facets/coupon/ICoupon.sol
//          packages/ats/contracts/contracts/facets/coupon/ICouponTypes.sol
//          packages/ats/contracts/contracts/facets/couponSecurityHolders/ICouponSecurityHolders.sol
//          packages/ats/contracts/contracts/facets/scheduledCrossOrderedTask/IScheduledCrossOrderedTasks.sol
//          packages/ats/contracts/contracts/facets/maturity/IMaturity.sol
//
// This file is in `script/`, not `src/`. Nothing the venue ships calls the
// factory: a token is deployed once by an operator and the venue is pointed at
// the address. Putting these declarations in `src/interfaces/` alongside the
// four seam interfaces would claim the factory is part of the seam, and the
// zero-fork contract in docs/CALLSTACK.md counts seam calls.
//
// Struct field order is load bearing. These are ABI-encoded against a factory
// deployed by Hashgraph in June 2026 which this repo cannot recompile, so a
// reordered field is a silently mis-decoded deployment rather than a compile
// error. Every struct below is field-for-field as upstream declares it.
pragma solidity ^0.8.24;

interface IAtsTypes {
    struct ResolverProxyConfiguration {
        bytes32 key;
        uint256 version;
    }

    struct ERC20MetadataInfo {
        string name;
        string symbol;
        string isin;
        uint8 decimals;
    }

    struct Rbac {
        bytes32 role;
        address[] members;
    }

    struct SecurityData {
        address resolver;
        uint256 maxSupply;
        ResolverProxyConfiguration resolverProxyConfiguration;
        ERC20MetadataInfo erc20MetadataInfo;
        Rbac[] rbacs;
        address[] externalPauses;
        address[] externalControlLists;
        address[] externalKycLists;
        address compliance;
        address identityRegistry;
        bool arePartitionsProtected;
        bool isMultiPartition;
        bool isControllable;
        bool isWhiteList;
        bool clearingActive;
        bool internalKycActivated;
        bool erc20VotesActivated;
    }

    struct BondDetailsData {
        bytes3 currency;
        uint256 nominalValue;
        uint8 nominalValueDecimals;
        uint256 startingDate;
        uint256 maturityDate;
    }

    struct BondData {
        SecurityData security;
        BondDetailsData bondDetails;
        address[] proceedRecipients;
        bytes[] proceedRecipientsData;
    }

    struct AdditionalSecurityData {
        bool countriesControlListType;
        string listOfCountries;
        string info;
    }

    /// @dev `NONE`/`NONE` is not a valid pair. `_isValidTypeAndSubType` admits
    ///      Reg S with no sub-type, or Reg D with 506(b) or 506(c), and nothing
    ///      else, so a deployment must pick one.
    enum RegulationType {
        NONE,
        REG_S,
        REG_D
    }

    enum RegulationSubType {
        NONE,
        REG_D_506_B,
        REG_D_506_C
    }

    struct FactoryRegulationData {
        RegulationType regulationType;
        RegulationSubType regulationSubType;
        AdditionalSecurityData additionalSecurityData;
    }

    enum RateCalculationStatus {
        PENDING,
        SET
    }

    struct Coupon {
        uint256 recordDate;
        uint256 executionDate;
        uint256 startDate;
        uint256 endDate;
        uint256 fixingDate;
        uint256 rate;
        uint8 rateDecimals;
        RateCalculationStatus rateStatus;
    }

    struct RegisteredCoupon {
        Coupon coupon;
        uint256 snapshotId;
    }

    struct CouponAmountFor {
        uint256 numerator;
        uint256 denominator;
        bool recordDateReached;
    }

    struct CouponFor {
        uint256 tokenBalance;
        uint8 decimals;
        uint256 nominalValue;
        uint256 nominalValueDecimals;
        bool recordDateReached;
        Coupon coupon;
        CouponAmountFor couponAmount;
        bool isDisabled;
    }
}

interface IAtsFactory is IAtsTypes {
    function deployBond(
        BondData calldata bondData,
        FactoryRegulationData calldata factoryRegulationData
    ) external returns (address bondAddress_);
}

/// @notice The ATS token surface used by the operator and the static client.
/// @dev Read as a list of the powers a token issuer holds over this venue, plus
///      the holder allowance needed to let RepoVault create an ATS hold. The
///      venue cannot mint, cannot set its own compliance module and cannot grant
///      itself a role. It is a counterparty to the token, not its owner.
interface IAtsToken {
    function grantRole(bytes32 role, address account) external returns (bool success_);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function setCompliance(address compliance) external;
    function compliance() external view returns (address);
    function issue(address tokenHolder, uint256 value, bytes calldata data) external;
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function balanceOfByPartition(bytes32 partition, address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function isExternalKycList(address kycList) external view returns (bool);
    function getExternalKycListsCount() external view returns (uint256);
    function isMultiPartition() external view returns (bool);
    function getSecurityHolders(uint256 pageIndex, uint256 pageLength)
        external
        view
        returns (address[] memory);
    function getTotalSecurityHolders() external view returns (uint256);
    function setCoupon(IAtsTypes.Coupon calldata coupon) external returns (uint256 couponId);
    function getCoupon(uint256 couponId)
        external
        view
        returns (IAtsTypes.RegisteredCoupon memory registeredCoupon, bool isDisabled);
    function getCouponFor(uint256 couponId, address account)
        external
        view
        returns (IAtsTypes.CouponFor memory);
    function getCouponAmountFor(uint256 couponId, address account)
        external
        view
        returns (IAtsTypes.CouponAmountFor memory);
    function getCouponHolders(uint256 couponId, uint256 pageIndex, uint256 pageLength)
        external
        view
        returns (address[] memory);
    function getCouponCount() external view returns (uint256);
    function getTotalCouponHolders(uint256 couponId) external view returns (uint256);
    function triggerScheduledCrossOrderedTasks(uint256 maxTasks) external returns (uint256);
    function scheduledCrossOrderedTaskCount() external view returns (uint256);
    function getMaturityDate() external view returns (uint256);
    function fullRedeemAtMaturity(address tokenHolder) external;
}
