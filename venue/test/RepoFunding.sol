// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {StubOracle} from "./OracleFixture.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";

interface IAtsFundingFixture {
    function mint(bytes32 partition, address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice External ATS eligibility seam with an allow-by-default test setup.
/// @dev Tests opt individual accounts out to model a grant expiring between
///      funding, acceptance, and default recovery.
contract KycListStub is IExternalKycList {
    mapping(address => bool) private _denied;

    function setEligible(address account, bool eligible) external {
        _denied[account] = !eligible;
    }

    function getKycStatus(address account) external view returns (IKyc.KycStatus) {
        return _denied[account] ? IKyc.KycStatus.NOT_GRANTED : IKyc.KycStatus.GRANTED;
    }
}

/// @notice Funded-offer open used by every repo suite after cash legs landed.
/// @dev Turns a dark stub on just long enough to quote, then restores it, so
///      `postMark` suites keep testing the dark-feed venue they were written for.
abstract contract RepoFunding is Test {
    uint64 internal constant OFFER_TTL = 7 days;
    uint256 internal constant DEFAULT_MARK_PER_UNIT = 1;

    function _newKycList() internal returns (KycListStub) {
        return new KycListStub();
    }

    /// @dev Funds only. Leaves the feed live so `accept` can still quote.
    function _fundRepo(
        RepoVault vault,
        StubOracle feed,
        address lender,
        address borrower,
        bytes32 id,
        RepoVault.Terms memory t
    ) internal returns (uint256 principal) {
        uint256 per = feed.stale() ? DEFAULT_MARK_PER_UNIT : feed.markPerUnitTinybar();
        if (feed.stale()) feed.setMark(per);
        principal = RepoMath.purchasePrice(per * t.collateralAmount, t.haircutBps);
        vm.deal(lender, lender.balance + principal);
        vm.prank(lender);
        vault.fundOffer{value: principal}(
            id, borrower, t, uint64(block.timestamp + OFFER_TTL)
        );
    }

    function _acceptRepo(
        RepoVault vault,
        StubOracle feed,
        address borrower,
        bytes32 id,
        RepoVault.Terms memory t,
        bool restoreDark
    ) internal {
        IAtsFundingFixture security = IAtsFundingFixture(address(vault.security()));
        security.mint(t.partition, borrower, t.collateralAmount);
        vm.prank(borrower);
        security.approve(address(vault), t.collateralAmount);
        vm.prank(borrower);
        vault.accept(id);
        if (restoreDark) feed.setDark(true);
    }

    function _openRepo(
        RepoVault vault,
        StubOracle feed,
        address lender,
        address borrower,
        bytes32 id,
        RepoVault.Terms memory t
    ) internal returns (uint256 principal) {
        bool dark = feed.stale();
        principal = _fundRepo(vault, feed, lender, borrower, id, t);
        _acceptRepo(vault, feed, borrower, id, t, dark);
    }

    /// @dev `cure` now reads the live mark. `postMark` still needs a dark feed.
    function _cureCovered(RepoVault vault, StubOracle feed, address borrower, bytes32 id)
        internal
    {
        bool dark = feed.stale();
        if (dark) feed.setMark(DEFAULT_MARK_PER_UNIT);
        vm.prank(borrower);
        vault.cure(id);
        if (dark) feed.setDark(true);
    }

    function _repayRepo(RepoVault vault, address borrower, bytes32 id)
        internal
        returns (uint256 price)
    {
        price = vault.repurchasePriceNow(id) + vault.settlementPenaltyNow(id);
        vm.deal(borrower, borrower.balance + price);
        vm.prank(borrower);
        return vault.close{value: price}(id);
    }
}
