// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title MerkleSet
/// @notice The one keccak tree discipline this repository has.
/// @dev Extracted from `ParameterRoot`, which held it inline and was the only
///      contract that needed it until `CouponDistributor` needed the same thing
///      for a different set. Two hand-written trees is how a repo ends up with
///      two answers to "what is the root of this set", so there is one file and
///      both callers pass their own domain tags into it.
///
/// ## Three rules, and each one is load-bearing
///
/// **Domain separation on every hash.** A leaf and a node are both a
/// `keccak256` over 32-byte words, so without a tag in front of each, a node
/// digest is a candidate preimage for a leaf and the tree admits a second valid
/// shape for one set. `ParameterRoot` publishes `hedera2026.param.leaf.v1` and
/// `hedera2026.param.node.v1`; `CouponDistributor` publishes its own pair. The
/// tags are constants on the contracts rather than on this library, because the
/// tag is the *tree's* identity and not the algorithm's.
///
/// **Keys ascend strictly.** A tree whose root depends on the order the caller
/// submitted its leaves in is not a commitment to a set, and the same comparison
/// that fixes the order rejects a duplicate key. `ascends` is the predicate;
/// each caller reverts with its own error so the selector a client already
/// decodes does not move.
///
/// **An odd node is promoted, never duplicated.** Duplicating the last node of
/// an odd level is the classic source of a second valid tree for one leaf
/// multiset: a set of `n` leaves and the same set with its last leaf repeated
/// hash to the same root. Promotion has no such collision, and it is why
/// `verify` needs the leaf count. See there.
library MerkleSet {
    /// @notice A leaf: one domain tag, one key, one value.
    /// @dev `abi.encode` and not `abi.encodePacked`. Every field here is already
    ///      a fixed 32 bytes so the two agree today, and they would stop
    ///      agreeing the moment a caller wanted a leaf over a dynamic type. The
    ///      standard-conformant encoding is the one that stays correct.
    function leafOf(bytes32 domain, bytes32 key, uint256 value)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(domain, key, value));
    }

    /// @notice A leaf inside a scope: the same shape with a discriminator first.
    /// @dev **This is what stops a proof crossing between two trees that share a
    ///      domain.** `CouponDistributor` publishes one root per coupon and every
    ///      one of them is a tree over `(holder, amount)`. Without the coupon
    ///      index inside the leaf, a holder entitled to a hundred on coupon 3 has
    ///      a valid proof of a hundred against any other coupon whose tree
    ///      happens to contain the same pair, and the distributor cannot tell the
    ///      two apart because the leaf is all it ever sees.
    ///
    ///      The scope goes in the leaf and not in the domain tag so that the tag
    ///      stays a published constant a client can check, rather than a value
    ///      derived per call.
    function leafOf(bytes32 domain, uint256 scope, bytes32 key, uint256 value)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(domain, scope, key, value));
    }

    /// @notice An interior node over an ordered pair. Never sorted.
    /// @dev Sorting the pair is the common shortcut and it buys a proof that
    ///      carries no direction bits. It also erases position from the tree,
    ///      which is exactly the information `verify` uses to know a promoted
    ///      node from a hashed one. This tree is positional.
    function nodeOf(bytes32 domain, bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encode(domain, a, b));
    }

    /// @notice The strict ascent every caller's key order has to satisfy.
    /// @dev A predicate rather than a revert so `ParameterRoot` and
    ///      `CouponDistributor` keep their own errors. Their selectors are in
    ///      published ABIs and a client decoding `KeysNotAscending(bytes32,
    ///      bytes32)` should not have to learn a new one because the rule moved
    ///      into a library.
    function ascends(bytes32 previous, bytes32 next) internal pure returns (bool) {
        return next > previous;
    }

    /// @notice Collapse an ordered leaf array to a root, in place.
    /// @dev Destroys `leaves`. Every caller here builds the array for this call
    ///      and drops it, and copying a level per round to avoid that is memory
    ///      the EVM charges quadratically for.
    function rootOfLeaves(bytes32 domain, bytes32[] memory leaves)
        internal
        pure
        returns (bytes32)
    {
        uint256 n = leaves.length;
        while (n > 1) {
            uint256 out = 0;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                leaves[out++] = nodeOf(domain, leaves[i], leaves[i + 1]);
            }
            // Promoted, not duplicated. See the class comment.
            if (n & 1 == 1) leaves[out++] = leaves[n - 1];
            n = out;
        }
        return leaves[0];
    }

    /// @notice Whether `leaf` sits at `position` in a `width`-leaf tree rooting
    ///         at `root`.
    /// @dev **`width` is not redundant and leaving it out is the bug this
    ///      comment exists to prevent.** With promotion, a level of odd size
    ///      carries its last node up without hashing it, so the number of proof
    ///      elements a path needs depends on where the path sits relative to
    ///      every odd level above it. A verifier that walked `proof.length`
    ///      levels instead would accept a path through a differently shaped tree
    ///      that happened to hash to the same root. `CouponDistributor` pins the
    ///      width at `declare` alongside the root, so the shape is part of what
    ///      was published rather than part of what a claimant asserts.
    ///
    ///      `p == proof.length` at the end is the second half of the same claim:
    ///      a proof carrying an unused tail is refused rather than ignored.
    function verify(
        bytes32 root,
        bytes32 domain,
        bytes32 leaf,
        uint256 position,
        uint256 width,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        if (width == 0 || position >= width) return false;

        bytes32 h = leaf;
        uint256 pos = position;
        uint256 p = 0;

        while (width > 1) {
            // The last node of an odd level rides up untouched, so this path
            // consumes no proof element at this height.
            if (!(width & 1 == 1 && pos == width - 1)) {
                if (p == proof.length) return false;
                bytes32 sibling = proof[p++];
                h = pos & 1 == 0 ? nodeOf(domain, h, sibling) : nodeOf(domain, sibling, h);
            }
            pos >>= 1;
            // Rounds up, which is promotion counted: an odd level of `n` yields
            // `(n - 1) / 2` hashed nodes and one promoted one.
            width = (width + 1) >> 1;
        }

        return h == root && p == proof.length;
    }
}
