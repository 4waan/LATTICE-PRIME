// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleSet} from "../src/merkle/MerkleSet.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {Regime} from "../src/policy/Regime.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {EpochClockMock} from "./PolicyFixture.sol";

/// @notice The one keccak tree, and the three rules it has.
/// @dev `ParameterRoot` held this code inline until `CouponDistributor` needed a
///      tree over a different set. The extraction is checked two ways: the
///      deployed parameter root is unchanged, which
///      `PolicySets.t.sol::test_theDeployedRootIsTheTestedRoot` asserts against
///      the value on chain 296, and the rules are asserted here directly rather
///      than only through the two callers that use them.
contract MerkleSetTest is Test {
    bytes32 internal constant LEAF = keccak256("test.leaf.v1");
    bytes32 internal constant NODE = keccak256("test.node.v1");
    bytes32 internal constant OTHER_LEAF = keccak256("test.other.leaf.v1");

    // ------------------------------------------------------ the collapse

    function _leaves(uint256 n) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = MerkleSet.leafOf(LEAF, bytes32(i), i + 1);
        }
    }

    function test_oneLeafIsItsOwnRoot() public pure {
        bytes32[] memory l = _leaves(1);
        bytes32 only = l[0];
        assertEq(MerkleSet.rootOfLeaves(NODE, l), only);
    }

    function test_twoLeavesHashInOrderAndNeverSorted() public pure {
        bytes32 a = MerkleSet.leafOf(LEAF, bytes32(uint256(0)), 1);
        bytes32 b = MerkleSet.leafOf(LEAF, bytes32(uint256(1)), 2);

        bytes32[] memory ab = new bytes32[](2);
        ab[0] = a;
        ab[1] = b;
        bytes32[] memory ba = new bytes32[](2);
        ba[0] = b;
        ba[1] = a;

        assertEq(MerkleSet.rootOfLeaves(NODE, ab), MerkleSet.nodeOf(NODE, a, b));
        assertTrue(
            MerkleSet.rootOfLeaves(NODE, ab) != MerkleSet.rootOfLeaves(NODE, ba),
            "a sorted-pair tree would make these equal, and this one is positional"
        );
    }

    /// @notice **Promotion is not duplication**, and this is the collision that
    ///         would exist if it were.
    /// @dev Duplicating the last node of an odd level makes a set of `n` leaves
    ///      and the same set with its last leaf repeated hash to the same root,
    ///      which is a second valid tree for one leaf multiset and the classic
    ///      way a merkle proof scheme is broken. Promotion has no such
    ///      collision. This test builds both trees and asserts they differ.
    function test_aPromotedNodeIsNotADuplicatedOne() public pure {
        bytes32[] memory three = _leaves(3);
        bytes32 promoted = MerkleSet.rootOfLeaves(NODE, three);

        // The same three leaves with the last one repeated, which is what a
        // duplicating implementation would have hashed instead.
        bytes32[] memory four = new bytes32[](4);
        bytes32[] memory src = _leaves(3);
        four[0] = src[0];
        four[1] = src[1];
        four[2] = src[2];
        four[3] = src[2];
        bytes32 duplicated = MerkleSet.rootOfLeaves(NODE, four);

        assertTrue(promoted != duplicated, "three leaves must not collide with four");
    }

    /// @notice A node digest is not a candidate preimage for a leaf.
    /// @dev The whole of what domain separation buys. Both are `keccak256` over
    ///      32-byte words, so without the tags a tree admits a second shape.
    function test_theDomainTagsSeparateALeafFromANode() public pure {
        bytes32 a = MerkleSet.leafOf(LEAF, bytes32(uint256(1)), 1);
        bytes32 b = MerkleSet.leafOf(LEAF, bytes32(uint256(2)), 2);
        assertTrue(MerkleSet.nodeOf(NODE, a, b) != MerkleSet.leafOf(LEAF, a, uint256(b)));
        assertTrue(
            MerkleSet.leafOf(LEAF, bytes32(uint256(1)), 1)
                != MerkleSet.leafOf(OTHER_LEAF, bytes32(uint256(1)), 1),
            "two trees with different tags do not share leaves"
        );
    }

    /// @notice The scoped leaf is what stops a proof crossing between trees.
    function test_aScopedLeafDiffersFromAnUnscopedOne() public pure {
        assertTrue(
            MerkleSet.leafOf(LEAF, 0, bytes32(uint256(1)), 100)
                != MerkleSet.leafOf(LEAF, bytes32(uint256(1)), 100)
        );
        assertTrue(
            MerkleSet.leafOf(LEAF, 3, bytes32(uint256(1)), 100)
                != MerkleSet.leafOf(LEAF, 4, bytes32(uint256(1)), 100),
            "the scope is what makes coupon 3's leaf not coupon 4's"
        );
    }

    function test_ascendsIsStrict() public pure {
        assertTrue(MerkleSet.ascends(bytes32(uint256(1)), bytes32(uint256(2))));
        assertFalse(MerkleSet.ascends(bytes32(uint256(2)), bytes32(uint256(1))));
        assertFalse(
            MerkleSet.ascends(bytes32(uint256(1)), bytes32(uint256(1))),
            "a duplicate key is rejected by the same comparison as an out-of-order one"
        );
    }

    // --------------------------------------------------------- the proofs

    /// @dev Rebuilt per level rather than kept as a tree, so the proof this
    ///      function produces and the path `verify` walks are two independent
    ///      traversals of the same rule rather than one shared piece of state.
    function _proofFor(uint256 n, uint256 position)
        internal
        pure
        returns (bytes32[] memory proof, bytes32 root)
    {
        bytes32[] memory level = _leaves(n);
        bytes32[] memory out = new bytes32[](64);
        uint256 p;
        uint256 pos = position;
        uint256 w = n;

        while (w > 1) {
            if (!(w & 1 == 1 && pos == w - 1)) {
                out[p++] = pos & 1 == 0 ? level[pos + 1] : level[pos - 1];
            }
            uint256 k;
            for (uint256 i = 0; i + 1 < w; i += 2) {
                level[k++] = MerkleSet.nodeOf(NODE, level[i], level[i + 1]);
            }
            if (w & 1 == 1) level[k++] = level[w - 1];
            w = k;
            pos >>= 1;
        }
        root = level[0];

        proof = new bytes32[](p);
        for (uint256 i = 0; i < p; ++i) {
            proof[i] = out[i];
        }
    }

    function _verify(
        bytes32 root,
        bytes32 leaf,
        uint256 position,
        uint256 width,
        bytes32[] calldata proof
    ) external pure returns (bool) {
        return MerkleSet.verify(root, NODE, leaf, position, width, proof);
    }

    /// @notice Every position in every tree from one leaf to nine verifies.
    /// @dev Nine because it covers both parities at every level: a width of nine
    ///      promotes at the leaves, at the next level and at the one after, which
    ///      is the case a verifier that counted `proof.length` levels gets wrong.
    function test_everyPositionVerifiesAtEveryWidth() public view {
        for (uint256 n = 1; n <= 9; ++n) {
            for (uint256 i = 0; i < n; ++i) {
                (bytes32[] memory proof, bytes32 root) = _proofFor(n, i);
                bytes32 leaf = MerkleSet.leafOf(LEAF, bytes32(i), i + 1);
                assertTrue(
                    this._verify(root, leaf, i, n, proof),
                    string.concat("width ", vm.toString(n), " position ", vm.toString(i))
                );
            }
        }
    }

    function test_aProofForTheWrongPositionIsRefused() public view {
        (bytes32[] memory proof, bytes32 root) = _proofFor(8, 3);
        bytes32 leaf = MerkleSet.leafOf(LEAF, bytes32(uint256(3)), 4);
        assertTrue(this._verify(root, leaf, 3, 8, proof), "the honest one");
        assertFalse(this._verify(root, leaf, 2, 8, proof), "shifted by one");
        assertFalse(this._verify(root, leaf, 7, 8, proof), "and by four");
    }

    /// @notice **The claim `width` exists for.** A path verified against a
    ///         different tree shape is a path through a tree nobody published.
    function test_aProofAgainstTheWrongWidthIsRefused() public view {
        (bytes32[] memory proof, bytes32 root) = _proofFor(7, 6);
        bytes32 leaf = MerkleSet.leafOf(LEAF, bytes32(uint256(6)), 7);
        assertTrue(this._verify(root, leaf, 6, 7, proof), "the honest one");
        assertFalse(this._verify(root, leaf, 6, 8, proof), "one wider");
        assertFalse(this._verify(root, leaf, 6, 6, proof), "one narrower");
    }

    /// @notice A proof carrying an unused tail is refused, not ignored.
    function test_aPaddedProofIsRefused() public view {
        (bytes32[] memory proof, bytes32 root) = _proofFor(4, 1);
        bytes32 leaf = MerkleSet.leafOf(LEAF, bytes32(uint256(1)), 2);
        assertTrue(this._verify(root, leaf, 1, 4, proof));

        bytes32[] memory padded = new bytes32[](proof.length + 1);
        for (uint256 i = 0; i < proof.length; ++i) {
            padded[i] = proof[i];
        }
        padded[proof.length] = keccak256("junk");
        assertFalse(this._verify(root, leaf, 1, 4, padded));
    }

    function test_anOutOfRangePositionIsRefused() public view {
        (bytes32[] memory proof, bytes32 root) = _proofFor(4, 0);
        bytes32 leaf = MerkleSet.leafOf(LEAF, bytes32(uint256(0)), 1);
        assertFalse(this._verify(root, leaf, 4, 4, proof), "position == width");
        assertFalse(this._verify(root, leaf, 0, 0, proof), "an empty tree proves nothing");
    }

    /// @notice A leaf nobody put in the tree does not verify against it.
    function testFuzz_anInventedLeafDoesNotVerify(uint256 value) public view {
        vm.assume(value != 3);
        (bytes32[] memory proof, bytes32 root) = _proofFor(5, 2);
        bytes32 invented = MerkleSet.leafOf(LEAF, bytes32(uint256(2)), value);
        assertFalse(this._verify(root, invented, 2, 5, proof));
    }

    // ------------------------------------------- the caller that predates it

    /// @notice `ParameterRoot` still builds the tree it always built.
    /// @dev The narrow version of `test_theDeployedRootIsTheTestedRoot`: that
    ///      one pins the root on chain 296 and this one pins the *shape*, by
    ///      rebuilding a two-key set out of the library by hand and comparing.
    ///      Between them, a change to either the tags or the collapse fails a
    ///      named test rather than a deployment.
    function test_theParameterRootIsStillTheLibrarysTree() public {
        EpochClockMock clock = new EpochClockMock();
        Regime regime =
            new Regime(L.TOP, L.BOTTOM, L.TOP, address(0x5E4), address(0x09E), clock);
        ParameterRoot params = new ParameterRoot(regime);

        ParameterRoot.Param[] memory set = new ParameterRoot.Param[](2);
        set[0] = ParameterRoot.Param(bytes32(uint256(7)), L.point(L.G_EXACT, L.T_IMM));
        set[1] = ParameterRoot.Param(bytes32(uint256(14)), L.point(L.G_PRED, L.T_IMM));

        bytes32 a = MerkleSet.leafOf(params.DOMAIN_LEAF(), set[0].key, set[0].value);
        bytes32 b = MerkleSet.leafOf(params.DOMAIN_LEAF(), set[1].key, set[1].value);
        assertEq(params.rootOf(set), MerkleSet.nodeOf(params.DOMAIN_NODE(), a, b));
    }

    /// @notice The ascending-key revert kept its selector when the rule moved.
    /// @dev A client decoding `KeysNotAscending(bytes32,bytes32)` should not
    ///      have to learn a new error because a library appeared, which is why
    ///      `MerkleSet.ascends` is a predicate and the revert stayed put.
    function test_theAscendingKeyRevertDidNotMove() public {
        EpochClockMock clock = new EpochClockMock();
        Regime regime =
            new Regime(L.TOP, L.BOTTOM, L.TOP, address(0x5E4), address(0x09E), clock);
        ParameterRoot params = new ParameterRoot(regime);

        ParameterRoot.Param[] memory set = new ParameterRoot.Param[](2);
        set[0] = ParameterRoot.Param(bytes32(uint256(14)), L.point(L.G_PRED, L.T_IMM));
        set[1] = ParameterRoot.Param(bytes32(uint256(7)), L.point(L.G_EXACT, L.T_IMM));

        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.KeysNotAscending.selector, set[0].key, set[1].key
            )
        );
        params.rootOf(set);
    }
}
