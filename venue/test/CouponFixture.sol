// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {ICashToken} from "../src/interfaces/ICashToken.sol";
import {MerkleSet} from "../src/merkle/MerkleSet.sol";

/// @title MockCashToken
/// @notice The HTS cash asset, including the one way its fee schedule can be
///         configured that breaks the distributor.
/// @dev Every switch here corresponds to a real disposition of a Hedera
///      fractional custom fee, measured in `spikes/d02-atomicity/fractional-fee.js`
///      before any of this was built, rather than to an invented failure.
///
///      **`netOfTransfers` is the one that matters.** A fractional fee is
///      ordinarily deducted from the amount transferred, so the recipient
///      receives less and the sender's balance falls by exactly the amount.
///      Set `netOfTransfers` and HTS charges the *sender* on top instead: the
///      sender's balance falls by amount plus fee. A distributor that assumed
///      the first would quietly over-spend its pool on every payment under the
///      second and discover it at the last claimant of the last coupon.
///      `CouponDistributor._pay` refuses instead, and this mock is how that is
///      asserted rather than asserted about.
contract MockCashToken is ICashToken {
    mapping(address => uint256) public balanceOf;
    uint8 private _decimals;

    /// @notice The fractional fee, in basis points.
    uint256 public feeBps;
    address public feeCollector = address(0xFEE);

    /// @notice False: the recipient bears the fee. True: the sender does.
    bool public netOfTransfers;

    /// @notice Makes `transfer` answer false rather than revert.
    /// @dev A standard-conformant token may do this, and a caller that ignored
    ///      the return would credit a payment that never moved.
    bool public refuse;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFee(uint256 bps, bool netOfTransfers_) external {
        feeBps = bps;
        netOfTransfers = netOfTransfers_;
    }

    function setRefuse(bool v) external {
        refuse = v;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (refuse) return false;
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 debit = netOfTransfers ? amount + fee : amount;
        uint256 credit = netOfTransfers ? amount : amount - fee;
        require(balanceOf[msg.sender] >= debit, "cash: balance");
        balanceOf[msg.sender] -= debit;
        balanceOf[to] += credit;
        balanceOf[feeCollector] += fee;
        return true;
    }
}

/// @title CouponFixture
/// @notice A calendar and a cash token, for every suite that needs a `RepoVault`.
/// @dev `RepoVault` took a `CouponSchedule` as a required immutable when
///      `noteCoupon` stopped taking a caller's word for the amount, so seven
///      suites that have nothing to say about coupons now have to construct one.
///      This is that, in one place, for `OracleFixture.StubOracle`'s reason: a
///      suite written against the old venue should keep testing the venue it was
///      written against and not acquire opinions about a calendar it never
///      mentions.
///
///      The schedule is deliberately long, twelve weekly coupons, so that a
///      suite which warps forward to reach one still has coupons ahead of it.
///      A four-coupon fixture ran out inside `DisclosureMeter`'s budget loops
///      and the failure read as a budget bug.
abstract contract CouponFixture {
    CouponSchedule internal couponSchedule;
    MockCashToken internal cashToken;

    /// @dev Seventy-five basis points over the reference. A number with no claim
    ///      behind it beyond being non-zero, which is what a fixture spread
    ///      should be: `PrimeOracle` publishes the leg that is measured.
    uint16 internal constant SPREAD_BPS = 75;

    /// @notice Nominal per unit, in the cash token's smallest unit.
    /// @dev The deployed bond is `nominalValue: "100.00"` in USD and the cash
    ///      token carries two decimals, so one unit of face is 10,000 of them.
    ///      `deployments/296-venue.json` `token.nominalValue`.
    uint128 internal constant FACE_VALUE = 10_000;

    uint8 internal constant CASH_DECIMALS = 2;

    uint64 internal constant COUPON_PERIOD = 7 days;
    uint256 internal constant COUPON_COUNT = 12;

    /// @notice A weekly calendar dated at `from`.
    function _deploySchedule(uint64 from) internal returns (CouponSchedule) {
        uint64[] memory dates = new uint64[](COUPON_COUNT);
        for (uint256 i = 0; i < COUPON_COUNT; ++i) {
            dates[i] = from + COUPON_PERIOD * uint64(i + 1);
        }
        couponSchedule =
            new CouponSchedule(from, dates, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
        return couponSchedule;
    }

    function _deployCash() internal returns (MockCashToken) {
        cashToken = new MockCashToken(CASH_DECIMALS);
        return cashToken;
    }

    // ------------------------------------------------------- entitlements

    /// @notice Build an entitlement tree the way the off-chain builder does.
    /// @dev **The Solidity twin of `tools/entitlements.mjs`**, which is what a
    ///      client runs against the mirror node. It is here rather than only in
    ///      `tools/` so a Solidity test can assert against a tree it built
    ///      itself, and the two are held together by shared literals rather than
    ///      by either calling the other: `test/UnitVectors.t.sol`'s
    ///      `EntitlementVectorsTest` and `tools/entitlements.test.mjs` carry the
    ///      same roots, leaves and proofs, and neither computes the other's.
    ///
    ///      Holders must ascend, for `MerkleSet.ascends`'s reason: the root has
    ///      to commit to a set and not to the order somebody handed the pairs
    ///      over in. The JS builder sorts instead of requiring, because its
    ///      caller is a mirror-node query with no reason to answer in address
    ///      order, and then enforces the same rule after the sort, where it
    ///      catches the thing that actually matters: a duplicate holder.
    function _entitlementRoot(uint256 index, address[] memory holders, uint256[] memory amounts)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory leaves = new bytes32[](holders.length);
        for (uint256 i = 0; i < holders.length; ++i) {
            if (i > 0) {
                require(
                    MerkleSet.ascends(
                        bytes32(uint256(uint160(holders[i - 1]))),
                        bytes32(uint256(uint160(holders[i])))
                    ),
                    "fixture: holders must ascend"
                );
            }
            leaves[i] = MerkleSet.leafOf(
                keccak256("hedera2026.coupon.entitlement.leaf.v1"),
                index,
                bytes32(uint256(uint160(holders[i]))),
                amounts[i]
            );
        }
        return
            MerkleSet.rootOfLeaves(keccak256("hedera2026.coupon.entitlement.node.v1"), leaves);
    }

    /// @notice The proof for one position, against the same construction.
    /// @dev Rebuilds the level array each round rather than keeping a full tree,
    ///      because a fixture that shared its intermediate state with the
    ///      verifier would be proving the two halves of one implementation agree
    ///      with each other.
    function _proof(
        uint256 index,
        address[] memory holders,
        uint256[] memory amounts,
        uint256 position
    ) internal pure returns (bytes32[] memory proof) {
        uint256 n = holders.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            level[i] = MerkleSet.leafOf(
                keccak256("hedera2026.coupon.entitlement.leaf.v1"),
                index,
                bytes32(uint256(uint160(holders[i]))),
                amounts[i]
            );
        }

        // Depth is at most ceil(log2(n)); an odd level contributes no element
        // for the promoted path, so the tail is trimmed at the end.
        bytes32[] memory out = new bytes32[](256);
        uint256 p = 0;
        uint256 pos = position;

        while (n > 1) {
            if (!(n & 1 == 1 && pos == n - 1)) {
                out[p++] = pos & 1 == 0 ? level[pos + 1] : level[pos - 1];
            }
            uint256 w = 0;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                level[w++] = MerkleSet.nodeOf(
                    keccak256("hedera2026.coupon.entitlement.node.v1"), level[i], level[i + 1]
                );
            }
            if (n & 1 == 1) level[w++] = level[n - 1];
            n = w;
            pos >>= 1;
        }

        proof = new bytes32[](p);
        for (uint256 i = 0; i < p; ++i) {
            proof[i] = out[i];
        }
    }
}
