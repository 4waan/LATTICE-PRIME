// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * Bounding what a malformed bn254 precompile call can cost.
 *
 * A precompile that REFUSES its input consumes every gas unit that was
 * forwarded to it. EIP-150 forwards 63/64 of the frame by default, so
 *
 *     address(0x08).staticcall(input)
 *
 * on bad input is not a cheap `false`. It is the most expensive revert the
 * frame can produce. Measured under revm on this repo's own probe: one
 * off-curve ecAdd inside a 16,000,000 gas transaction burned 15,728,134 gas.
 * On Hedera, where the per-call ceiling is 15,000,000,
 * that is the whole call.
 *
 * The fix is to forward a bounded amount. `staticcall{gas: n}` caps what a
 * failure can take, and n is knowable exactly because EIP-1108 fixes the price
 * and we measured it on the target chain rather than assuming it. Measured by
 * gas-step bisection at eth_call level, Hedera testnet:
 *
 *     0x06 ecAdd     150
 *     0x07 ecMul    6000
 *     0x08 pairing  45000 + 34000 * k
 *
 * Failure modes of the cap, stated so they are chosen rather than discovered:
 *
 *   - If a chain ever reprices bn254 upward, a capped call to a WORKING
 *     precompile runs out of gas and this contract reports `ran == false`.
 *     That fails closed (a proof is rejected, never accepted) and it is
 *     detectable, which an uncapped burn is not.
 *   - The cap does not make a rejection free. It makes it cost the cap.
 *   - `ran` and `ok` are separate return values on purpose. Collapsing them is
 *     the fail-open bug: a precompile that is absent, out of gas, or refusing
 *     all look like "not true" and must never look like "verified".
 *
 * G1 input can also be rejected before it ever reaches the precompile.
 * bn254 G1 has COFACTOR = 1, so the curve group IS the prime-order subgroup and
 * an on-curve test is a COMPLETE validity test: no separate subgroup check is
 * needed. That is two mulmods and an addmod. G2 has a cofactor greater than one
 * and needs a real subgroup check, so G2 is left to the precompile behind a cap.
 */
contract SafeBn254 {
    uint256 internal constant P =
        0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;

    uint256 internal constant ADD_GAS = 150;
    uint256 internal constant MUL_GAS = 6000;
    uint256 internal constant PAIR_BASE = 45000;
    uint256 internal constant PAIR_PER = 34000;

    /// Complete validity test for a bn254 G1 point, because COFACTOR == 1.
    /// (0, 0) is the encoding of the point at infinity per EIP-196 and is valid.
    function isValidG1(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        if (x == 0 && y == 0) return true;
        return mulmod(y, y, P) == addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
    }

    /// ecAdd with the loss on malformed input bounded to ADD_GAS.
    function safeAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal view returns (bool ran, uint256 x3, uint256 y3)
    {
        if (!isValidG1(x1, y1) || !isValidG1(x2, y2)) return (false, 0, 0);
        bytes memory input = abi.encode(x1, y1, x2, y2);
        bool success;
        bytes32[2] memory out;
        assembly ("memory-safe") {
            success := staticcall(ADD_GAS, 0x06, add(input, 32), 128, out, 64)
        }
        if (!success) return (false, 0, 0);
        return (true, uint256(out[0]), uint256(out[1]));
    }

    /// ecMul with the loss on malformed input bounded to MUL_GAS.
    /// Any 256-bit scalar is accepted: EIP-196 reduces it mod r.
    function safeMul(uint256 x, uint256 y, uint256 k)
        internal view returns (bool ran, uint256 x2, uint256 y2)
    {
        if (!isValidG1(x, y)) return (false, 0, 0);
        bytes memory input = abi.encode(x, y, k);
        bool success;
        bytes32[2] memory out;
        assembly ("memory-safe") {
            success := staticcall(MUL_GAS, 0x07, add(input, 32), 96, out, 64)
        }
        if (!success) return (false, 0, 0);
        return (true, uint256(out[0]), uint256(out[1]));
    }

    /// ecPairing with the loss on malformed input bounded to the exact
    /// EIP-1108 price for k pairs. `ran == false` means the precompile did not
    /// produce an answer: reject, and do not read `ok`.
    function safePairing(bytes memory input)
        internal view returns (bool ran, bool ok)
    {
        if (input.length % 192 != 0) return (false, false);
        uint256 cap = PAIR_BASE + PAIR_PER * (input.length / 192);
        bool success;
        // `bytes32 out` would be a STACK slot, and `staticcall(..., out, 32)`
        // would then write the pairing result to memory offset 0 (Solidity's
        // scratch space) while `out` kept its stack value. The check would read
        // whatever was already in scratch. A one-element array is a MEMORY
        // pointer, which is what the assembly needs. This was a real bug in the
        // first draft of this file, caught by the bilinearity vector returning
        // false for an input every chain agrees is true.
        bytes32[1] memory out;
        assembly ("memory-safe") {
            success := staticcall(cap, 0x08, add(input, 32), mload(input), out, 32)
        }
        if (!success) return (false, false);
        return (true, out[0] == bytes32(uint256(1)));
    }

    // ---- measurement probes: what does a rejection actually cost? ----

    /// Uncapped staticcall on an off-curve point. Forwards 63/64 of the frame
    /// and loses all of it. This is the shape ordinary verifier code has.
    function burnUncapped() external view returns (uint256 burned) {
        bytes memory input = abi.encode(uint256(1), uint256(3), uint256(1), uint256(2));
        uint256 g0 = gasleft();
        (bool s, ) = address(0x06).staticcall(input);
        burned = g0 - gasleft();
        require(!s, "expected rejection");
    }

    /// Same input, capped. The loss is ADD_GAS plus frame overhead.
    function burnCapped() external view returns (uint256 burned) {
        uint256 g0 = gasleft();
        (bool ran, , ) = safeAdd(1, 3, 1, 2);
        burned = g0 - gasleft();
        require(!ran, "expected rejection");
    }

    /// Capped, but with the Solidity on-curve check removed, so the cap alone
    /// is doing the work. Separates "the cap helps" from "the check helps".
    function burnCappedNoPrecheck() external view returns (uint256 burned) {
        bytes memory input = abi.encode(uint256(1), uint256(3), uint256(1), uint256(2));
        uint256 g0 = gasleft();
        bool success;
        bytes32[2] memory out;
        assembly ("memory-safe") {
            success := staticcall(ADD_GAS, 0x06, add(input, 32), 128, out, 64)
        }
        burned = g0 - gasleft();
        require(!success, "expected rejection");
    }

    /// Happy path through the capped wrapper, to price what the safety costs.
    function costCappedValid() external view returns (uint256 used, uint256 x3) {
        uint256 g0 = gasleft();
        (bool ran, uint256 x, ) = safeAdd(1, 2, 1, 2);
        used = g0 - gasleft();
        require(ran, "expected success");
        x3 = x;
    }

    /// A real 2-pair bilinearity check through the capped wrapper.
    function pairingCapped(bytes memory input)
        external view returns (bool ran, bool ok, uint256 used)
    {
        uint256 g0 = gasleft();
        (ran, ok) = safePairing(input);
        used = g0 - gasleft();
    }
}
