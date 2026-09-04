// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title RootWindow
/// @notice The freshness window, once, for the two problems that are the same
///         problem: `the study plan` D11d.2 (a proof made against a policy root
///         that governance has since moved) and F5b (a proof of non-revocation
///         made against a revocation root that has since moved).
///
/// ## Why this is a library and not two contracts
///
/// D11d.2 proposed one shared mechanism and `the design notes` a design decision refined
/// the proposal in the only way that matters:
///
/// > Share the mechanism, not the setting.
///
/// | root | accepted | failure mode if stale |
/// |---|---|---|
/// | revocation | `DEPTH_CURRENT_ONLY` | a revoked credential trades. Compliance failure |
/// | parameter | `DEPTH_ONE_BEHIND` | an old policy applies for one grace period. Latency |
///
/// Collapsing those onto one `N` would price a compliance failure at the cost of
/// a latency. So `depth` is an argument and never a constant of the library, and
/// the two call sites are two deployments of one piece of arithmetic.
///
/// ## Why "last N roots" is not enough on its own
///
/// D11d.2 says "the contract accepts the last N roots". Taken literally that is
/// not a window: if the root never moves again, the superseded root stays
/// acceptable forever, and a window that never closes is a second live policy.
/// So a superseded root carries the moment it was superseded, and acceptance is
/// bounded in **time** as well as in count. `depth` says how many roots may be
/// live at once; `grace` says for how long.
library RootWindow {
    /// @notice A root, its predecessor, and when the predecessor stopped being
    ///         current. `supersededAt == 0` means there has never been one.
    struct Window {
        bytes32 current;
        bytes32 previous;
        uint64 supersededAt;
    }

    /// @notice Revocation. Once the root moves, nothing proved against the old
    ///         one passes, and no operator discretion enters that.
    uint8 internal constant DEPTH_CURRENT_ONLY = 1;

    /// @notice Parameters. A proof already in flight when governance lands is
    ///         still good until the grace expires.
    uint8 internal constant DEPTH_ONE_BEHIND = 2;

    /// @notice The grace, and it is the same 93 seconds a design decision derived for the
    ///         revocation delta, for the same reason: a proof in flight. Ninety
    ///         seconds of our own off-chain conduct plus roughly three seconds of
    ///         Hedera consensus finality. It is a service level and not a
    ///         cryptographic bound, and the two roots share the number while
    ///         differing in depth, which is what a design decision's rule actually asks for.
    uint64 internal constant GRACE = 93 seconds;

    error RootUnchanged(bytes32 root);

    /// @notice Move the root forward, retiring the current one into the window.
    function advance(Window storage w, bytes32 next) internal {
        if (next == w.current) revert RootUnchanged(next);
        w.previous = w.current;
        w.supersededAt = uint64(block.timestamp);
        w.current = next;
    }

    /// @notice Whether a proof declaring root `r` should be accepted now.
    /// @dev `r == 0` is refused whatever the depth. A zero root is an unpublished
    ///      root, and accepting it would let a proof verify against nothing at
    ///      all before the first publication. Fail closed, in the same direction
    ///      as seam D in a design decision.
    function accepts(Window storage w, bytes32 r, uint8 depth, uint64 grace)
        internal
        view
        returns (bool)
    {
        if (r == bytes32(0)) return false;
        if (r == w.current) return true;
        if (depth < DEPTH_ONE_BEHIND) return false;
        if (r != w.previous) return false;
        // Bounded in time as well as in count. See the header.
        return block.timestamp <= w.supersededAt + grace;
    }

    /// @notice When the window closes on the superseded root. Zero if none.
    function closesAt(Window storage w, uint8 depth, uint64 grace)
        internal
        view
        returns (uint64)
    {
        if (depth < DEPTH_ONE_BEHIND || w.supersededAt == 0) return 0;
        return w.supersededAt + grace;
    }
}
