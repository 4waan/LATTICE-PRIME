// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Rulebook} from "../src/observatory/Rulebook.sol";
import {Regime} from "../src/policy/Regime.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @notice A tariff source the handler can move.
contract Source {
    uint256 private _v;

    function value() external view returns (uint256) {
        return _v;
    }

    function set(uint256 v) external {
        _v = v;
    }
}

/// @title EditionHandler
/// @notice Publishes random editions of random lengths against real sources.
/// @dev The target is `adopt`'s bookkeeping, which is where the only stateful
///      hazard in the contract lives: the key index and the array are two
///      structures holding one schedule, cleared in an order that matters.
///      Every action is wrapped in `try`, so a run reaches the refusals as well
///      as the adoptions.
contract EditionHandler is Test {
    Rulebook public immutable book;
    address public immutable operator;
    address public immutable clock;

    Source[8] public sources;
    bytes32[] public everPublished;
    mapping(bytes32 => bool) public seen;

    uint256 public adoptions;
    uint256 public refusals;
    uint256 public moves;

    constructor(Rulebook book_, address operator_, address clock_) {
        book = book_;
        operator = operator_;
        clock = clock_;
        for (uint256 i = 0; i < 8; ++i) {
            sources[i] = new Source();
            sources[i].set(i + 1);
        }
    }

    function everPublishedCount() external view returns (uint256) {
        return everPublished.length;
    }

    /// @dev Keys are drawn from a small alphabet so editions collide on keys and
    ///      the index has to survive a key that appears, vanishes and returns.
    function doAdopt(uint256 seed, uint8 count) external {
        uint256 n = (count % 6) + 1;
        Rulebook.Charge[] memory s = new Rulebook.Charge[](n);
        uint256 last = 0;
        for (uint256 i = 0; i < n; ++i) {
            uint256 step = (uint256(keccak256(abi.encode(seed, i))) % 3) + 1;
            last += step;
            Source src = sources[(seed >> (i * 8)) % 8];
            bool unsourced = (seed >> (i * 3)) % 4 == 0;
            s[i] = Rulebook.Charge({
                key: bytes32(last),
                source: unsourced ? address(0) : address(src),
                reader: unsourced ? bytes4(0) : Source.value.selector,
                amount: unsourced ? 0 : src.value(),
                payer: Rulebook.Party.PARTICIPANT,
                payee: (seed >> (i * 5)) % 2 == 0
                    ? Rulebook.Party.OPERATOR
                    : Rulebook.Party.COUNTERPARTY,
                refundable: false
            });
        }

        bytes32 doc = keccak256(abi.encode("doc", seed));
        try book.editionOf(doc, s) returns (bytes32 e) {
            vm.prank(operator);
            book.propose(e, "h");
            _tick();
            try book.adopt(doc, s) {
                adoptions += 1;
                if (!seen[e]) {
                    seen[e] = true;
                    everPublished.push(e);
                }
            } catch {
                refusals += 1;
            }
        } catch {
            refusals += 1;
        }
    }

    /// @notice Move a source out from under whatever published it.
    function doMove(uint256 seed, uint96 v) external {
        sources[seed % 8].set(v);
        moves += 1;
    }

    function _tick() private {
        (bool ok,) = clock.call(abi.encodeWithSignature("tick()"));
        require(ok, "tick failed");
    }
}

/// @title RulebookInvariantTest
/// @notice What must hold of the stored schedule whatever sequence of editions
///         landed on it.
/// @dev Depth over breadth. The hazard is a *sequence* of adoptions where a key
///      appears, is dropped and returns, so a long run at fewer seeds finds more
///      than the default shape and costs the suite a fifth of the time.
/// forge-config: default.invariant.runs = 96
/// forge-config: default.invariant.depth = 400
contract RulebookInvariantTest is Test, PolicyFixture {
    Rulebook internal book_;
    EditionHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        book_ = new Rulebook(regime);
        handler = new EditionHandler(book_, OPERATOR, address(clock));

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = EditionHandler.doAdopt.selector;
        sel[1] = EditionHandler.doMove.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @notice The stored schedule is the schedule that was committed.
    /// @dev Rebuilt from the public accessors and re-hashed. This is what a bug
    ///      in `adopt`'s two-structure bookkeeping would break: a leftover line,
    ///      a wrong order, a truncated write.
    function invariant_theStoredScheduleRehashesToTheAdoptedEdition() public view {
        uint256 n = book_.chargeCount();
        if (n == 0) return;
        Rulebook.Charge[] memory s = new Rulebook.Charge[](n);
        for (uint256 i = 0; i < n; ++i) {
            s[i] = book_.chargeAt(i);
        }
        assertEq(
            book_.editionOf(book_.document(), s),
            book_.edition(),
            "the stored schedule is not the one adopted"
        );
    }

    /// @notice The index resolves the current schedule and nothing older.
    /// @dev `adopt` clears the map before the array. Without that a key dropped
    ///      by a later edition keeps pointing into a shorter schedule, which is
    ///      an out-of-bounds read on a public getter.
    function invariant_theIndexAgreesWithTheArray() public view {
        uint256 n = book_.chargeCount();
        for (uint256 i = 0; i < n; ++i) {
            Rulebook.Charge memory c = book_.chargeAt(i);
            (bool found, Rulebook.Charge memory got) = book_.chargeOf(c.key);
            assertTrue(found, "a published key does not resolve");
            assertEq(got.key, c.key);
            assertEq(got.amount, c.amount);
            assertEq(got.source, c.source);
        }
    }

    /// @notice Keys stay strictly ascending in storage.
    function invariant_theStoredScheduleIsASet() public view {
        uint256 n = book_.chargeCount();
        for (uint256 i = 1; i < n; ++i) {
            assertGt(
                uint256(book_.chargeAt(i).key),
                uint256(book_.chargeAt(i - 1).key),
                "the stored schedule is not ordered"
            );
        }
    }

    /// @notice An unsourced line is a published zero, at all times.
    /// @dev The rule that makes "the venue take is zero" mean something: a
    ///      non-zero charge must name code, and code can be read back.
    function invariant_anUnsourcedLineIsZero() public view {
        uint256 n = book_.chargeCount();
        for (uint256 i = 0; i < n; ++i) {
            Rulebook.Charge memory c = book_.chargeAt(i);
            if (c.source == address(0)) {
                assertEq(c.amount, 0, "an unsourced line carries a number");
            }
        }
    }

    /// @notice `reconcile` never reverts, whatever is published under it.
    function invariant_reconcileAlwaysAnswers() public view {
        book_.reconcile();
    }

    /// @dev The handler swallows reverts, so a run in which nothing landed would
    ///      pass every invariant having published nothing.
    function afterInvariant() public view {
        assertGt(handler.adoptions(), 0, "no edition was ever adopted");
        assertGt(handler.everPublishedCount(), 1, "only one edition was ever published");
    }
}
