// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title AxeGrid
/// @notice Sealed coverage bitmap and band arithmetic. Pure.
/// @dev 8 × 16 × 16 cells, tree depth 11. Size bands reuse the venue's
///      base-ten bucket (capped). Rate bands are 25 bp. Coverage is symmetric
///      interval intersection so a high-rate probe is not free. The root binds
///      a set, not a rectangle; a rectangle is 18 bits (`RECTANGLE_BITS`).
library AxeGrid {
    uint8 internal constant CLASS_CARD = 8;
    uint8 internal constant SIZE_CARD = 16;
    uint8 internal constant RATE_CARD = 16;
    uint256 internal constant RATE_BAND_BPS = 25;
    uint16 internal constant CELL_CARD = 2048;
    uint8 internal constant DEPTH = 11;
    uint16 internal constant RECTANGLE_BITS = 18;

    bytes32 internal constant DOMAIN_LEAF = keccak256("hedera2026.axegrid.leaf.v1");
    bytes32 internal constant DOMAIN_NODE = keccak256("hedera2026.axegrid.node.v1");
    bytes32 internal constant DOMAIN_SALT = keccak256("hedera2026.axegrid.salt.v1");

    error BadClass(uint8 classId);
    error BadBand(uint8 band);
    error EmptyRange(uint8 lo, uint8 hi);

    struct Rect {
        uint8 classId;
        uint8 sizeLo;
        uint8 sizeHi;
        uint8 rateLo;
        uint8 rateHi;
    }

    function sizeBand(uint256 v) internal pure returns (uint8 b) {
        while (v >= 10 && b < SIZE_CARD - 1) {
            v /= 10;
            b += 1;
        }
    }

    function sizeBandLow(uint8 b) internal pure returns (uint256) {
        if (b >= SIZE_CARD) revert BadBand(b);
        if (b == 0) return 0;
        return 10 ** uint256(b);
    }

    function sizeBandHigh(uint8 b) internal pure returns (uint256) {
        if (b >= SIZE_CARD) revert BadBand(b);
        if (b == SIZE_CARD - 1) return type(uint256).max;
        return 10 ** (uint256(b) + 1) - 1;
    }

    function rateBand(uint256 bps) internal pure returns (uint8) {
        uint256 b = bps / RATE_BAND_BPS;
        if (b >= RATE_CARD) return RATE_CARD - 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(b);
    }

    function rateBandLow(uint8 b) internal pure returns (uint256) {
        if (b >= RATE_CARD) revert BadBand(b);
        return uint256(b) * RATE_BAND_BPS;
    }

    function rateBandHigh(uint8 b) internal pure returns (uint256) {
        if (b >= RATE_CARD) revert BadBand(b);
        if (b == RATE_CARD - 1) return type(uint256).max;
        return (uint256(b) + 1) * RATE_BAND_BPS - 1;
    }

    /// @dev class || size || rate. Leaf order is part of the commitment.
    function cellOf(uint8 classId, uint8 sBand, uint8 rBand) internal pure returns (uint16) {
        if (classId >= CLASS_CARD) revert BadClass(classId);
        if (sBand >= SIZE_CARD) revert BadBand(sBand);
        if (rBand >= RATE_CARD) revert BadBand(rBand);
        return (uint16(classId) << 8) | (uint16(sBand) << 4) | uint16(rBand);
    }

    function cellFor(uint8 classId, uint256 lot, uint256 rateBps)
        internal
        pure
        returns (uint16)
    {
        return cellOf(classId, sizeBand(lot), rateBand(rateBps));
    }

    function classOfCell(uint16 cell) internal pure returns (uint8) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(cell >> 8);
    }

    function sizeOfCell(uint16 cell) internal pure returns (uint8) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((cell >> 4) & 0x0F);
    }

    function rateOfCell(uint16 cell) internal pure returns (uint8) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(cell & 0x0F);
    }

    function bandRect(
        uint8 classId,
        uint256 sizeLo,
        uint256 sizeHi,
        uint256 rateLoBps,
        uint256 rateHiBps
    ) internal pure returns (Rect memory r) {
        if (classId >= CLASS_CARD) revert BadClass(classId);
        if (sizeLo > sizeHi) revert EmptyRange(0, 0);
        if (rateLoBps > rateHiBps) revert EmptyRange(0, 0);
        r = Rect({
            classId: classId,
            sizeLo: sizeBand(sizeLo),
            sizeHi: sizeBand(sizeHi),
            rateLo: rateBand(rateLoBps),
            rateHi: rateBand(rateHiBps)
        });
    }

    function covers(Rect memory r, uint16 cell) internal pure returns (bool) {
        if (classOfCell(cell) != r.classId) return false;
        uint8 s = sizeOfCell(cell);
        if (s < r.sizeLo || s > r.sizeHi) return false;
        uint8 t = rateOfCell(cell);
        return t >= r.rateLo && t <= r.rateHi;
    }

    function rectangleCount() internal pure returns (uint256) {
        uint256 s = (uint256(SIZE_CARD) * (uint256(SIZE_CARD) + 1)) / 2;
        uint256 t = (uint256(RATE_CARD) * (uint256(RATE_CARD) + 1)) / 2;
        return uint256(CLASS_CARD) * s * t;
    }

    function rectangleBits() internal pure returns (uint16 bits) {
        uint256 n = rectangleCount();
        uint256 pow = 1;
        while (pow < n) {
            pow <<= 1;
            bits += 1;
        }
    }

    /// @dev Per-leaf salt. Without it the 2,048-cell domain is enumerable.
    function saltOf(bytes32 master, uint16 cell) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SALT, master, cell));
    }

    /// @dev Cell is in the preimage; `verify` walks by index. Both, or a
    ///      sorted-pair proof would accept a leaf at the wrong position.
    function leafOf(uint16 cell, bool covered, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_LEAF, cell, covered, salt));
    }

    function _node(bytes32 l, bytes32 r) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_NODE, l, r));
    }

    function _leaves(Rect memory r, bytes32 master)
        private
        pure
        returns (bytes32[] memory level)
    {
        level = new bytes32[](CELL_CARD);
        for (uint256 i = 0; i < CELL_CARD; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 cell = uint16(i);
            level[i] = leafOf(cell, covers(r, cell), saltOf(master, cell));
        }
    }

    /// @dev Off-chain only: 2,048 leaves.
    function rootOf(Rect memory r, bytes32 master) internal pure returns (bytes32) {
        bytes32[] memory level = _leaves(r, master);
        uint256 n = CELL_CARD;
        while (n > 1) {
            n /= 2;
            for (uint256 i = 0; i < n; ++i) {
                level[i] = _node(level[2 * i], level[2 * i + 1]);
            }
        }
        return level[0];
    }

    function openingOf(Rect memory r, bytes32 master, uint16 cell)
        internal
        pure
        returns (bool covered, bytes32 salt, bytes32[] memory proof)
    {
        covered = covers(r, cell);
        salt = saltOf(master, cell);
        proof = new bytes32[](DEPTH);

        bytes32[] memory level = _leaves(r, master);
        uint256 idx = cell;
        uint256 n = CELL_CARD;
        for (uint256 d = 0; d < DEPTH; ++d) {
            proof[d] = level[idx ^ 1];
            n /= 2;
            for (uint256 i = 0; i < n; ++i) {
                level[i] = _node(level[2 * i], level[2 * i + 1]);
            }
            idx >>= 1;
        }
    }

    function verify(
        bytes32 root,
        uint16 cell,
        bool covered,
        bytes32 salt,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        if (proof.length != DEPTH) return false;
        if (cell >= CELL_CARD) return false;
        bytes32 h = leafOf(cell, covered, salt);
        uint256 idx = cell;
        for (uint256 d = 0; d < DEPTH; ++d) {
            h = (idx & 1 == 0) ? _node(h, proof[d]) : _node(proof[d], h);
            idx >>= 1;
        }
        return h == root;
    }
}
