// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title SeamMap
/// @notice GENERATED. Do not edit. `make census` rewrites this file.
///
/// One record per ATS entry point that reaches a seam or moves a balance.
/// `test/SeamCoverage.t.sol` asserts the findings over it, so an upgrade that
/// opens, closes or reorders a rail breaks a test.
///
/// Source: hashgraph/asset-tokenization-studio v8.0.0 be4f860
/// Tool:   tools/callstack.mjs, then tools/gen-seammap.mjs
/// Rows:   102 of 393 entry points
library SeamMap {
    // ------------------------------------------------------------ seam bits

    /// `IExternalPause.isPaused`. Typed call, OR over the registered list.
    uint8 internal constant A = 1 << 0;
    /// `IExternalControlList.isAuthorized`. Typed call, AND, one address.
    uint8 internal constant B = 1 << 1;
    /// `ICompliance.canTransfer`. STATICCALL, pre-state, carries the value.
    uint8 internal constant C = 1 << 2;
    /// `ICompliance.transferred | created | destroyed`. CALL, post-state.
    uint8 internal constant CW = 1 << 3;
    /// `IExternalKycList.getKycStatus`. Typed call, AND, one address.
    uint8 internal constant D = 1 << 4;
    /// `IIdentityRegistry.isVerified`. STATICCALL, one address.
    uint8 internal constant E = 1 << 5;

    /// D is `ZkKycRegistry`, C and CW are `SeamJournal`.
    uint8 internal constant VENUE_OBSERVED = C | CW | D;
    /// Runs before the balance moves. CW does not.
    uint8 internal constant PRE_STATE = A | B | C | D | E;

    // ----------------------------------------------------------- write bits

    uint8 internal constant W_TRANSFER = 1 << 0;
    uint8 internal constant W_ISSUE = 1 << 1;
    uint8 internal constant W_REDEEM = 1 << 2;
    /// Every holder rescaled at once.
    uint8 internal constant W_ADJUST = 1 << 3;
    uint8 internal constant W_HOLD = 1 << 4;
    uint8 internal constant W_HOLDMOVE = 1 << 5;
    uint8 internal constant W_LOCK = 1 << 6;

    /// Value changes hands. The set ATS gates.
    uint8 internal constant W_MOVES = W_TRANSFER | W_ISSUE | W_REDEEM | W_HOLDMOVE;
    /// Immobilised or rescaled in place. The set it does not.
    uint8 internal constant W_ENCUMBERS = W_HOLD | W_LOCK | W_ADJUST;
    uint8 internal constant W_ANY = W_MOVES | W_ENCUMBERS;

    // --------------------------------------------------------------- table

    uint256 internal constant COUNT = 102;
    /// 12 bytes per record: id(8) | seams(1) | writes(1) | incidental(1) | depth(1).
    uint256 internal constant STRIDE = 12;

    bytes internal constant TABLE = hex"a03c85eda71e3a600108000ef60809ab0f7993d201000811708d99a6d0ffd12601000005fec0121d6b3f13ee0100000570e04e886af36f370100081432fbf19ab7277b54010000052e0bbb7d28b831d1011008147be1469668a1cf8901000811a617183351caf815010000053e42e575904430490100081143a9b7c0e3d022f93f01081495948f1b20a0bdc63f040813208b000cc8bce85301000005fdb448e6c60358bf010000058c89f055afb099bc3f10081413915b707f729a243f100814430f3611657fdf8e010008130c0861122d04743501000813d99b92f88e63b531010008137777f68e97f4c90401000814b48fa31f8a524ee73f100814f54b1b817fdbc48a01000813ed8f1f5f02507a47010008132733925ba41c9c64370000095338bc524ee2b54e3700000967c503a3e26f6f3701000005c96d80ef5a3fd08837000009b6af03041b8bea633700000932ce2959270a5f2901000005a14edbdff7f0015b090408149cf80b5021359ae9090108144c47c5699edcad2e090108148cf25f22bd69297501000005fddfefb8336e11f0090408134828bed04e52187309010813088604e5dfdfb18a011008133ad25c3ae8a1968b0100000564d41d407866b0b8010000056549a4cfe6681e090100000b21416bb2a4e4cf890100000be41555e22209c3d801000005dd884a38b1e12df8010000056898e41e7fae22bf01000005d3e7a52ccb0ab19901000005840b1faacc4b303201000005f40836a0933694e601000005f64cb03c1629d82801000005356ab5c54207cfe601000005ffefd2afa06746341000000258c4d80d04fd885f0100000502c4ad0c1e796f6201000005d499699107514a2c01000005d855a2d728c107b401000005631c709e24beba1c01000005831092fe293a3f4301000811dc69010796624f7f01000005c93c7171b3ef749401000811cecd34d08e872a1e0110081331573ace074286b601100813017bc6b0196281c73f2008143ca94e148572a0690b00081583f95b75fc27d1f30b0008153b566ce46d1cf877010008101b36fae30e77e92c0100080f96e7583e829f252c0100080f59db158949d153420100080f8149c05efd3bd02b01000005c57a39bf339166ec01000005fe360089c5ad2cc3110000066ce16e88980caaa40100000526b3ba3afadad7d70140081241e70559ae2accd80100081293ca602edb870a9c010000051dcd9834bbc07a3a1b040814726ef029cf9ced8d01000005a80db441f007324b1b040813bec3d89884caf9c23f020813d69aba2d72daf58901000813c116f8418a0a373d01000813db8e030f82e37b6e0110081310d7224b88338e68010000057a25d0006491e423010000050bff17a31db6458901000005c71670c3bab0035201000005382d827492c26d7801000003d6ae8b3b451c701e01000814b6fa545bced12d2001000814c09b12164e47f6880110081408e5ff45ed36e532090108122cd96d760a0d6a3a010000058786c0904c8c980f0100000523975124caf183ca01000006a523bed2e18498090100080eed5dc82142e5f16e0100080e2ddd540f573cd4aa0100080ef078ceb13de5ca9601000005b694951e6f3d067f01000005add5dbc7b8c30da401000005c96290f99c53b28a3f01081375b2c6c7cc8aea9a010000052851e0b19460949401000005928d5ed520ab723801000005";

    error NoSuchOp(bytes8 op);

    /// @notice `keccak256("Contract.fn")` truncated to eight bytes. The
    ///         generator proves no collision.
    function id(string memory qualifiedName) internal pure returns (bytes8) {
        return bytes8(keccak256(bytes(qualifiedName)));
    }

    /// @notice One record. `incidental` is the set of balance sinks the entry
    ///         point reaches only through the lazy scheduled task dispatcher.
    function recordAt(uint256 i)
        internal
        pure
        returns (bytes8 op, uint8 seams, uint8 writes, uint8 incidental, uint8 depth)
    {
        bytes memory t = TABLE;
        uint256 o = i * STRIDE;
        assembly {
            let word := mload(add(add(t, 0x20), o))
            op := word
            seams := byte(8, word)
            writes := byte(9, word)
            incidental := byte(10, word)
            depth := byte(11, word)
        }
    }

    /// @notice Look one entry point up by name. Reverts if it is not measured:
    ///         a silent zero would read as "reaches no seam".
    function recordOf(string memory qualifiedName)
        internal
        pure
        returns (bytes8 op, uint8 seams, uint8 writes, uint8 incidental, uint8 depth)
    {
        bytes8 want = id(qualifiedName);
        for (uint256 i = 0; i < COUNT; ++i) {
            (op, seams, writes, incidental, depth) = recordAt(i);
            if (op == want) return (op, seams, writes, incidental, depth);
        }
        revert NoSuchOp(want);
    }

    function seamsOf(string memory qualifiedName) internal pure returns (uint8) {
        (, uint8 seams,,,) = recordOf(qualifiedName);
        return seams;
    }

    function writesOf(string memory qualifiedName) internal pure returns (uint8) {
        (,, uint8 writes,,) = recordOf(qualifiedName);
        return writes;
    }

    function incidentalOf(string memory qualifiedName) internal pure returns (uint8) {
        (,,, uint8 incidental,) = recordOf(qualifiedName);
        return incidental;
    }

    function has(uint8 set, uint8 bit) internal pure returns (bool) {
        return set & bit == bit;
    }
}
