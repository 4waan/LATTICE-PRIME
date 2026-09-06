// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RootWindow
/// @notice Last-N roots, bounded in time. Share the mechanism, not the setting.
/// @dev Revocation: `DEPTH_CURRENT_ONLY`. Parameters: `DEPTH_ONE_BEHIND`.
///      Grace is 93s (90s off-chain + ~3s Hedera finality). A window that never
///      closes is a second live policy.
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

    /// @notice 93 seconds: 90s off-chain plus ~3s Hedera finality. SLA, not crypto.
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
    /// @dev `r == 0` is unpublished; refuse it (fail closed).
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
