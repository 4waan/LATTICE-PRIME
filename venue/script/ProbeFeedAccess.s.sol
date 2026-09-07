// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title FeedAccessProbe
/// @notice Reads a price feed **as a contract**, and hands back what happened.
/// @dev The evidence behind `src/oracle/HederaRateFeed.sol`'s reason for
///      existing, in a form anybody can re-run without trusting a transcript.
///
///      Chainlink's proxies on Hedera are access controlled. The controller
///      admits a caller when it is allowlisted or when `msg.sender ==
///      tx.origin`, so an externally owned account reading the feed sees a
///      price and a contract reading the same feed sees `No access`. That
///      difference cannot be shown with `eth_call` alone, because `eth_call`
///      sets `tx.origin` to whatever `from` says and the two are equal again.
///      It needs a contract in the middle, and this is that contract.
///
///      Deployed once to chain 296 and recorded in `deployments/296-venue.json`
///      under `evidence`. `probes/chainlink-hedera.py` calls it for every feed.
contract FeedAccessProbe {
    /// @notice Call `feed` with `data` and return the outcome rather than revert.
    /// @return ok Whether the call succeeded.
    /// @return ret The returndata, which on a failure is the revert payload.
    function probe(address feed, bytes calldata data)
        external
        view
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = feed.staticcall(data);
    }

    /// @notice The four reads a Chainlink consumer makes, in one call.
    /// @dev Named separately because the interesting result is the *pair*: the
    ///      scale answers and the price does not, which is precisely why a
    ///      constructor that validates `decimals()` will happily seat a feed it
    ///      can never price against. `test_aFeedThatAnswersDecimalsAndRefusesPricesIsSeatableAndDark`
    ///      is the same fact as a test.
    function probeFeed(address feed)
        external
        view
        returns (
            bool decimalsOk,
            bytes memory decimalsRet,
            bool priceOk,
            bytes memory priceRet
        )
    {
        (decimalsOk, decimalsRet) = feed.staticcall(abi.encodeWithSignature("decimals()"));
        (priceOk, priceRet) = feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
    }
}

contract ProbeFeedAccess is Script {
    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        vm.startBroadcast(pk);
        FeedAccessProbe p = new FeedAccessProbe();
        vm.stopBroadcast();
        console2.log("feedAccessProbe  ", address(p));
    }
}

/// @notice The same probe with nothing deployed and nothing spent.
/// @dev `forge script` runs its body against a local fork of whatever RPC it is
///      pointed at, and a fork carries the target chain's *contract* bytecode.
///      Chainlink's access controller is ordinary contract code, so it executes
///      on a fork exactly as it does on the network, which makes this the way to
///      ask the same question of **mainnet** without deploying anything to it.
///
///      It is not a way to ask about a system contract: `0x168` and `0x16b` are
///      the node's, not bytecode, and a fork has neither. That is why
///      `HederaRateFeed` is read with `cast` against the real relay instead.
///
///        FEED=0x1B9a65b54e36A4f4E3591e4deAAb423C64959Ae0 \
///        forge script script/ProbeFeedAccess.s.sol:ForkProbe \
///          --rpc-url https://mainnet.hashio.io/api
contract ForkProbe is Script {
    function run() external {
        address feed = vm.envAddress("FEED");
        FeedAccessProbe p = new FeedAccessProbe();
        (bool dOk, bytes memory dRet, bool pOk, bytes memory pRet) = p.probeFeed(feed);

        console2.log("feed            ", feed);
        console2.log("  extcodesize   ", feed.code.length);
        console2.log("  decimals()  ok", dOk);
        if (dOk && dRet.length == 32) console2.log("    ->          ", abi.decode(dRet, (uint256)));
        console2.log("  latestRoundData() ok", pOk);
        if (!pOk) {
            console2.log("    revert payload:");
            console2.logBytes(pRet);
            if (pRet.length > 68) {
                console2.log("    reason:", abi.decode(_slice(pRet), (string)));
            }
        }
    }

    /// @dev Drop the four byte `Error(string)` selector so the tail decodes.
    function _slice(bytes memory b) private pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i + 4];
        }
    }
}
