// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Emitted by gendata.js from the snarkjs proof files. The G2 element order is
// swapped here because EIP-197 takes Fp2 imaginary part first while snarkjs
// writes real part first, the same convention snarkjs applies in its own
// exportsoliditycalldata.
contract ProofData {
    uint constant Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // generated from build/trivial_proof.json, do not hand edit
    function tA() internal pure returns (uint[2] memory a) {
        a[0] = uint(0x05172748618b948d1d92fd6ea9749f334f9969e90025fe81ef75b0dcb7fec5ed); a[1] = uint(0x1d82cf685962dbfa419fe0b13531b3428ffe17dfb438e60337e388a40f5e2d5f);
    }
    function tB() internal pure returns (uint[2][2] memory b) {
        b[0][0] = uint(0x18c7a882d9d6e702eeca9b7b3fb4b526bdde041ae20feb08c6621b04d6df4f35); b[0][1] = uint(0x2a5ab0f2e46c3eaebf11e24ede6b81d112199e273ca35f4fec9fed29d08071fb);
        b[1][0] = uint(0x2b1ea631653b3e2934cdd643a09af135164f004601673bf2cd8f95a853961ca4); b[1][1] = uint(0x117930f8fad53e93c5243adad5da1d457b4b64c5cf9edfdc093ba6637a1814ca);
    }
    function tC() internal pure returns (uint[2] memory c) {
        c[0] = uint(0x0d33e113a8f1c1c30ee925d46e0361eb2c0b735a787fbf6ced19fc8ecd77f96b); c[1] = uint(0x300951b391f23579d3b9b633d20ce6d39ce92fe90fb428c72eadfb047a820efa);
    }
    function tPub() internal pure returns (uint[1] memory z) {
        z[0] = uint(0x0000000000000000000000000000000000000000000000000000000000000021);
    }

    // generated from build/five_proof.json, do not hand edit
    function fA() internal pure returns (uint[2] memory a) {
        a[0] = uint(0x15b718138282ad478f49123a897b75b96a26de6cddd5090bcc9850e0ffc8f6c9); a[1] = uint(0x0a2654c97b3beccdffcd9917aee08805027e25e8e467331edefd8f00a3790981);
    }
    function fB() internal pure returns (uint[2][2] memory b) {
        b[0][0] = uint(0x2982b3485e711abb2e1aa02a54dcdaddae16a57c774609eee40e1688b249d340); b[0][1] = uint(0x0578f45f9d172a5cd7e4a1fd5c3359d89b086583033eb876b1e4e400888cbcab);
        b[1][0] = uint(0x16d25570f7a5e3b57c56f6281160028381de9d13467c039e38f9ff1be07db1e7); b[1][1] = uint(0x09d29216ed4e2f2297d4d2f3227ab50e920c04dd2681c75d362b382d3d9c1841);
    }
    function fC() internal pure returns (uint[2] memory c) {
        c[0] = uint(0x1c6e2e74f206b76360579a2e23f5b7f7ac280eedf76af5115f3b8bce6b872aad); c[1] = uint(0x06e9b94bb584e75290687d1dd18693199987758885b6d813d4cc1dcbf9e2c8d5);
    }
    function fPub() internal pure returns (uint[5] memory z) {
        z[0] = uint(0x0000000000000000000000000000000000000000000000000000000000000130);
        z[1] = uint(0x0000000000000000000000000000000000000000000000000000000000000003);
        z[2] = uint(0x0000000000000000000000000000000000000000000000000000000000000005);
        z[3] = uint(0x0000000000000000000000000000000000000000000000000000000000000007);
        z[4] = uint(0x000000000000000000000000000000000000000000000000000000000000000b);
    }
}
