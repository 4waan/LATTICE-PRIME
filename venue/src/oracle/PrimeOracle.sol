// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPrimeOracle} from "../interfaces/IPrimeOracle.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {OracleMath} from "./OracleMath.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";

/// @title PrimeOracle
/// @notice The venue's mark. Half of it is ours and half of it is not.
/// @dev Removes the one seat in this venue held by an address rather than by a
///      contract. `docs/RULEBOOK.md` §4.
///
/// ## Two legs, and only one of them was ours to build
///
/// The deployed instrument is `"kind": "bond, variable rate"`. A variable coupon
/// resets against a reference rate, a repo is marked against a clean price, and
/// neither number existed anywhere in this venue: `RepoVault.postMark` took a
/// commitment from an externally owned account and `DeployVenue.s.sol` said so in
/// a comment rather than fixing it.
///
/// Two prices are needed and the venue is entitled to publish one of them.
///
/// - **The clean price of LPRC**, USD per unit of face. A private bond with one
///   venue trading it. Nobody else quotes it, so a quorum of seated publishers
///   is the only honest source and the median below is how their answers become
///   one number.
/// - **HBAR/USD**, because the instrument is denominated in USD and every cash
///   figure in this venue — `principal`, `credit`, `commitBond`, the whole repo
///   leg — is denominated in tinybars. Nothing on chain converted between them
///   before this contract.
///
/// So the composite is `cleanPrice / hbarUsd`, our number over somebody else's,
/// and the only part built from scratch is the part nobody else publishes.
///
/// **Who that somebody is was decided by measurement, not by preference.** The
/// design named Chainlink, which does run HBAR/USD on Hedera. Chainlink's
/// proxies here are access controlled and refuse a contract caller with `No
/// access` while answering `decimals()` to anyone, on testnet and on mainnet
/// alike, so the seat below took a feed it could never price against and the
/// failure surfaced at the first `markToMarket` rather than at deployment. The
/// whole measurement, including the on-chain probe that shows the difference an
/// `eth_call` cannot, is `probes/chainlink-hedera.out`.
///
/// The seat is a governed address rather than a constant, so what it holds is a
/// deployment decision. On Hedera it holds `HederaRateFeed`, an adapter over the
/// network's own exchange rate at `0x168` in this same interface's shape. On a
/// chain where a contract may read a Chainlink aggregator, `proposeCashFeed`
/// seats one and nothing else changes.
///
/// ## What it publishes, and under which row
///
/// A clean price, a reference rate and a maturity date are terms of the bond.
/// Row 7 sits at `(exact, imm)` in the deployed matrix and that is where both
/// numbers go. `rate x lot` is a position and stays where row 14 put it: this
/// contract never learns a lot size and `RepoVault.markToMarket` multiplies in
/// memory and stores nothing.
///
/// **Both events route through `_emitUnder`, and a narrowed row therefore takes
/// the feed dark rather than silencing it.** That is not an oversight. A ceiling
/// breach reverts, a reverting `finalize` publishes no price, and a venue that
/// may not publish a price is a venue that must not act on one. The seat that
/// opens when this contract goes dark is `RepoVault.postMark`, which is now
/// reachable on no other condition.
/// `test_narrowingRowSevenTakesTheFeedDarkAndOpensTheManualSeat` is that claim.
///
/// ## What a publisher can still do
///
/// Submissions are open: a publisher who answers last sees the answers already
/// in. Hiding the price in the event would be theatre, because `submit` takes it
/// in calldata and `panelOf` reads it back out of storage, and this venue has
/// already refused that trade once in `RepoVault.close`. What bounds a late
/// publisher is arithmetic rather than secrecy — the median moves by at most one
/// order statistic per dishonest answer, the deviation cap bounds the round
/// against the last one the venue agreed on, and the quorum sets how many
/// answers a round needs. `docs/manipulation-surface.md` carries the row and
/// `probes/market-abuse.py` carries the case.
contract PrimeOracle is IPrimeOracle, AggregatorV3Interface, DisclosureView {
    using OracleMath for uint256[];

    // ---------------------------------------------------------------- rows

    /// @dev Instrument reference data. A clean price and a coupon reference rate
    ///      are terms of the bond, published the way a maturity date is.
    uint16 internal constant ROW_ASSET = 7;

    /// @dev Who answered and when. The number is in calldata either way; what an
    ///      observer gains from the event is the panel's cadence, which is the
    ///      row the venue has always charged that against.
    uint16 internal constant ROW_CADENCE = 16;

    // ----------------------------------------------------------- the scales

    /// @notice Decimals on both legs and on the composite's numerator.
    /// @dev Eight, because that is what every Chainlink feed on Hedera answers
    ///      with, measured rather than assumed: `probes/chainlink-hedera.out`
    ///      reads `decimals()` off all seven. Matching it means the division in
    ///      `markPerUnitTinybar` cancels the scale instead of carrying it, and
    ///      means there is one price scale in this repository rather than two.
    uint8 public constant DECIMALS = 8;

    /// @notice Tinybars in one HBAR. `tools/units.mjs` holds the client's copy.
    uint256 internal constant TINYBAR = 1e8;

    uint256 internal constant BPS = 10_000;

    // ------------------------------------------------------------ the seats

    /// @notice May propose a panel or a cash feed. Cannot adopt either.
    address public immutable admin;

    /// @notice Answers a round needs before `finalize` will take a median.
    uint8 public immutable quorum;

    /// @notice The largest panel that may ever be seated.
    /// @dev Immutable because it is what makes the sort in `finalize` a known
    ///      cost rather than a governed one. A panel bound that governance could
    ///      raise is a gas bound governance could raise.
    uint8 public immutable maxPublishers;

    /// @notice Seconds after which the venue's own leg is dark.
    uint64 public immutable heartbeat;

    /// @notice Seconds after which the upstream leg is dark.
    /// @dev A separate number because it is not ours to choose. Chainlink
    ///      publishes HBAR/USD on a 86,400 second heartbeat with a 0.5 percent
    ///      deviation trigger, so a value below that would read a healthy feed
    ///      as dark on a quiet day. Read off the feed registry and recorded in
    ///      `deployments/296-venue.json`, not guessed.
    uint64 public immutable cashHeartbeat;

    /// @notice How far one finalised round may sit from the last one.
    uint16 public immutable maxDeviationBps;

    // ---------------------------------------------------------- the publishers

    address[] private _panel;
    mapping(address => bool) public seated;

    address[] private _pendingPanel;
    /// @notice Epoch the proposed panel becomes adoptable. Zero when none.
    uint64 public pendingPanelEpoch;

    /// @notice The upstream HBAR/USD aggregator. Chainlink's, not ours.
    AggregatorV3Interface public cashFeed;
    AggregatorV3Interface public pendingCashFeed;
    uint64 public pendingCashFeedEpoch;

    // ------------------------------------------------------------- the rounds

    struct Answer {
        uint128 price;
        uint64 rate;
        address by;
    }

    struct Round {
        uint128 price;
        uint64 rate;
        /// @dev Not `at`. See `IPrimeOracle.latest`: `ethers` resolves a tuple
        ///      member called `at` to `Array.prototype.at`.
        uint64 publishedAt;
        uint8 panel;
        /// @dev Which seating decided it. See `generation`.
        uint64 gen;
    }

    /// @notice The last finalised round. Zero before the first one.
    uint64 public lastRound;

    /// @notice How many panels have been seated, counting the one in the
    ///         constructor. The open round's answers are keyed by it.
    /// @dev **A seating restarts the open round.** Without this the round that
    ///      straddles a panel change is decided partly by publishers who no
    ///      longer hold a seat, and the array `finalize` sorts is no longer
    ///      bounded by `maxPublishers`, because a disjoint replacement panel can
    ///      add its own answers on top of the outgoing one's. Neither is
    ///      acceptable: the first is a median over a panel that does not exist,
    ///      the second is an unbounded sort on a governed input.
    ///
    ///      Restarting is also the only version that cannot wedge. Discarding
    ///      the answers but keeping the marks would lock a returning publisher
    ///      out of a round they may no longer answer; capping the array would
    ///      leave a round that can never reach quorum and an open round that
    ///      never closes. Bumping the generation clears both the answers and the
    ///      marks in one write, and the round number a reader sees is unchanged.
    uint64 public generation;

    mapping(uint64 => Round) private _rounds;
    mapping(uint256 => Answer[]) private _open;
    mapping(uint256 => mapping(address => bool)) private _spoke;

    // -------------------------------------------------------------- events

    /// @dev No price. It is in calldata and in `panelOf`, so an event carrying
    ///      it would disclose nothing further; what this event is for is that a
    ///      seated publisher answered, and when.
    event Submitted(uint64 indexed round, address indexed publisher, uint8 answers);
    event Finalized(uint64 indexed round, uint128 cleanPrice, uint64 refRateBps, uint8 panel);
    event PanelProposed(uint64 indexed effectiveEpoch, uint256 size);
    event PanelAdopted(uint64 indexed epoch, uint256 size);
    event CashFeedProposed(address indexed next, uint64 indexed effectiveEpoch);
    event CashFeedAdopted(address indexed next, uint64 indexed epoch);

    // -------------------------------------------------------------- errors

    error NotAdmin();
    error NotPublisher(address who);
    error WrongRound(uint64 got, uint64 want);
    error AlreadyAnswered(address who, uint64 round);
    error ZeroPrice();
    error QuorumShort(uint256 answers, uint8 quorum_);
    error DeviationTooLarge(uint256 from, uint256 to, uint16 capBps);
    error PanelSize(uint256 size, uint8 quorum_, uint8 max);
    error PanelNotDistinct(address who);
    error NotYetEffective(uint64 want, uint64 have);
    error NothingPending();
    error FeedDecimals(uint8 got, uint8 want);
    error FeedStale(uint64 publishedAt, uint64 heartbeat_);
    error CashFeedStale(address feed);
    error NoData();
    error ZeroInterval();

    // --------------------------------------------------------- construction

    constructor(
        IDisclosurePolicy policy_,
        address admin_,
        AggregatorV3Interface cashFeed_,
        address[] memory panel_,
        uint8 quorum_,
        uint8 maxPublishers_,
        uint64 heartbeat_,
        uint64 cashHeartbeat_,
        uint16 maxDeviationBps_
    ) DisclosureView(policy_) {
        if (heartbeat_ == 0 || cashHeartbeat_ == 0) revert ZeroInterval();
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > BPS) {
            revert DeviationTooLarge(0, 0, maxDeviationBps_);
        }
        if (quorum_ == 0 || quorum_ > maxPublishers_) {
            revert PanelSize(panel_.length, quorum_, maxPublishers_);
        }
        if (panel_.length < quorum_ || panel_.length > maxPublishers_) {
            revert PanelSize(panel_.length, quorum_, maxPublishers_);
        }

        admin = admin_;
        quorum = quorum_;
        maxPublishers = maxPublishers_;
        heartbeat = heartbeat_;
        cashHeartbeat = cashHeartbeat_;
        maxDeviationBps = maxDeviationBps_;

        _requireEightDecimals(cashFeed_);
        cashFeed = cashFeed_;
        emit CashFeedAdopted(address(cashFeed_), policy_.currentEpoch());

        _seat(panel_);
        emit PanelAdopted(policy_.currentEpoch(), panel_.length);
    }

    // ------------------------------------------------------- the write side

    /// @notice A seated publisher's answer for the open round.
    /// @dev The round is an argument and has to equal the open one. A `submit`
    ///      that silently landed in whatever round was open when it was mined
    ///      would let a publisher's answer to a stale question be counted
    ///      against a fresh one, and the publisher would have no way to say no.
    function submit(uint64 round, uint128 cleanPrice, uint64 refRateBps) external {
        if (!seated[msg.sender]) revert NotPublisher(msg.sender);
        uint64 want = lastRound + 1;
        if (round != want) revert WrongRound(round, want);
        uint256 slot = _slot(generation, round);
        if (_spoke[slot][msg.sender]) revert AlreadyAnswered(msg.sender, round);
        if (cleanPrice == 0) revert ZeroPrice();

        _spoke[slot][msg.sender] = true;
        _open[slot].push(Answer({price: cleanPrice, rate: refRateBps, by: msg.sender}));

        // Bounded by `maxPublishers` and not merely small: one answer per seated
        // publisher per generation, a panel that never exceeds `maxPublishers`,
        // and a seating that bumps the generation. That is what keeps the sort
        // in `finalize` a known cost.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 n = uint8(_open[slot].length);
        if (_emitUnder(bytes32(uint256(round)), ROW_CADENCE, L.G_PRED, L.T_IMM)) {
            emit Submitted(round, msg.sender, n);
        }
    }

    /// @notice Take the median of the open round and make it the venue's mark.
    /// @dev Permissionless, following `ZkKycRegistry.adoptGate` and
    ///      `ParameterRoot.adopt`: if only a publisher could close a round, the
    ///      timing of finalisation would be a second discretionary signal on top
    ///      of the answers, and the quorum would buy less than it appears to.
    function finalize(uint64 round) external returns (uint128 price, uint64 rate) {
        uint64 want = lastRound + 1;
        if (round != want) revert WrongRound(round, want);

        uint64 gen = generation;
        Answer[] storage open = _open[_slot(gen, round)];
        uint256 n = open.length;
        if (n < quorum) revert QuorumShort(n, quorum);

        uint256[] memory prices = new uint256[](n);
        uint256[] memory rates = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            prices[i] = open[i].price;
            rates[i] = open[i].rate;
        }

        // Safe: every element came out of a `uint128` and a `uint64` field, and
        // the median of a set is bounded by its own maximum.
        // forge-lint: disable-next-line(unsafe-typecast)
        price = uint128(prices.median());
        // forge-lint: disable-next-line(unsafe-typecast)
        rate = uint64(rates.median());

        // The cap binds against the last round the venue agreed on. It is not
        // applied to the reference rate: a rate near zero moves by thousands of
        // basis points on an ordinary day and a cap that refused that would be a
        // cap that refuses the ordinary case.
        uint128 previous = _rounds[lastRound].price;
        if (previous != 0) {
            uint256 moved = OracleMath.deviationBps(price, previous);
            if (moved > maxDeviationBps) {
                revert DeviationTooLarge(previous, price, maxDeviationBps);
            }
        }

        // Safe: `n` is the length of an array bounded by `maxPublishers`, a
        // `uint8`, by the generation rule above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 panel = uint8(n);
        _rounds[round] = Round({
            price: price,
            rate: rate,
            publishedAt: uint64(block.timestamp),
            panel: panel,
            gen: gen
        });
        lastRound = round;

        if (_emitUnder(bytes32(uint256(round)), ROW_ASSET, L.G_EXACT, L.T_IMM)) {
            emit Finalized(round, price, rate, panel);
        }
    }

    // ---------------------------------------------------------- the read side

    /// @inheritdoc IPrimeOracle
    function latest()
        public
        view
        returns (uint128 cleanPrice, uint64 refRateBps, uint64 publishedAt, uint64 round)
    {
        round = lastRound;
        Round storage r = _rounds[round];
        return (r.price, r.rate, r.publishedAt, round);
    }

    /// @inheritdoc IPrimeOracle
    function referenceRateBefore(uint64 cutoff)
        external
        view
        returns (uint64 refRateBps, uint64 publishedAt, uint64 round)
    {
        uint64 high = lastRound;
        if (high == 0 || _rounds[1].publishedAt >= cutoff) revert NoData();

        uint64 low = 1;
        while (low < high) {
            uint64 middle = low + (high - low + 1) / 2;
            if (_rounds[middle].publishedAt < cutoff) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        Round storage r = _rounds[low];
        if (uint256(cutoff) > uint256(r.publishedAt) + heartbeat) {
            revert FeedStale(r.publishedAt, heartbeat);
        }
        return (r.rate, r.publishedAt, low);
    }

    /// @notice The venue's own leg, without the upstream one.
    /// @dev Split out because the two go dark for different reasons and a client
    ///      showing "the feed is down" should be able to say which half.
    function ourLegStale() public view returns (bool) {
        uint64 publishedAt = _rounds[lastRound].publishedAt;
        return publishedAt == 0 || block.timestamp > uint256(publishedAt) + heartbeat;
    }

    /// @inheritdoc IPrimeOracle
    function stale() public view returns (bool) {
        if (ourLegStale()) return true;
        (bool ok,,) = _cash();
        return !ok;
    }

    /// @notice The upstream leg as this contract reads it. Never reverts.
    /// @param ok False whenever the venue must not act on it.
    /// @param usdPerHbar Eight decimals, on the scale Chainlink set and this
    ///        venue follows.
    function cashLeg()
        external
        view
        returns (bool ok, uint256 usdPerHbar, uint64 updatedAt)
    {
        return _cash();
    }

    /// @inheritdoc IPrimeOracle
    function markPerUnitTinybar() public view returns (uint256) {
        Round storage r = _rounds[lastRound];
        if (ourLegStale()) revert FeedStale(r.publishedAt, heartbeat);
        (bool ok, uint256 usdPerHbar,) = _cash();
        if (!ok) revert CashFeedStale(address(cashFeed));

        // Both legs carry eight decimals, so the scale cancels and what is left
        // is HBAR per unit of face. Multiplying by `TINYBAR` first rather than
        // dividing first keeps the result in whole tinybars instead of throwing
        // the fraction away.
        //
        // The bound, asserted in `test_theMarkCannotOverflowAtTheBoundsOfTheTypes`
        // rather than assumed: `price` is a `uint128`, so the numerator is at
        // most 2^128 * 1e8, about 3.4e46. `RepoVault` then multiplies by a lot
        // bounded by the bond's `maxSupply` of 1,000,000, reaching 3.4e52
        // against a `uint256` ceiling of 1.1e77.
        return (uint256(r.price) * TINYBAR) / usdPerHbar;
    }

    /// @dev Every defensive read a Chainlink consumer owes an upstream feed, in
    ///      one place, and the seat holds an adapter rather than Chainlink only
    ///      because Chainlink refused to answer a contract on this chain. The
    ///      checks are the same ones either way. The `try` is the important one:
    ///      the seated feed is code
    ///      this repository does not control, its proxy can be pointed
    ///      somewhere else upstream, and a revert there must read as a dark feed
    ///      rather than propagate into `stale()`. `stale()` is what
    ///      `RepoVault.postMark` gates the manual seat on, so a `stale()` that
    ///      could revert would be a venue with no working mark at all.
    function _cash() private view returns (bool ok, uint256 usdPerHbar, uint64 updatedAt) {
        AggregatorV3Interface f = cashFeed;
        if (address(f) == address(0)) return (false, 0, 0);
        try f.latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 feedUpdatedAt,
            uint80 answeredInRound
        ) {
            if (answer <= 0) return (false, 0, 0);
            // An in-progress round carries a zero timestamp, and an answer
            // carried over from an earlier round answers an older question than
            // the id claims.
            if (
                feedUpdatedAt == 0 || feedUpdatedAt > block.timestamp
                    || feedUpdatedAt > type(uint64).max || answeredInRound < roundId
            ) return (false, 0, 0);
            if (block.timestamp - feedUpdatedAt > cashHeartbeat) return (false, 0, 0);
            // Safe: the answer and timestamp bounds are guarded above.
            // forge-lint: disable-next-line(unsafe-typecast)
            return (true, uint256(answer), uint64(feedUpdatedAt));
        } catch {
            return (false, 0, 0);
        }
    }

    /// @notice The answers a round was decided from, in arrival order.
    /// @dev Published because a median nobody can check is a number on trust.
    ///      The order is arrival and not sorted, so a reader can see who spoke
    ///      last as well as what the panel said.
    function panelOf(uint64 round) external view returns (Answer[] memory) {
        return _open[_slot(_genOf(round), round)];
    }

    function publishers() external view returns (address[] memory) {
        return _panel;
    }

    function publisherCount() external view returns (uint256) {
        return _panel.length;
    }

    function pendingPublishers() external view returns (address[] memory) {
        return _pendingPanel;
    }

    /// @notice The round `submit` and `finalize` are working on.
    function openRound() external view returns (uint64) {
        return lastRound + 1;
    }

    function roundOf(uint64 round) external view returns (Round memory) {
        return _rounds[round];
    }

    function answered(uint64 round, address publisher) external view returns (bool) {
        return _spoke[_slot(_genOf(round), round)][publisher];
    }

    /// @dev A finalised round is read back under the generation that decided it;
    ///      anything else is the open round, which is the current one. Without
    ///      this, a seating would appear to erase the answer list of every round
    ///      already published.
    function _genOf(uint64 round) private view returns (uint64) {
        Round storage r = _rounds[round];
        return r.publishedAt == 0 ? generation : r.gen;
    }

    function _slot(uint64 gen, uint64 round) private pure returns (uint256) {
        return (uint256(gen) << 64) | uint256(round);
    }

    // ------------------------------------------------- AggregatorV3Interface

    /// @dev The clean price and not the composite. A consumer that speaks this
    ///      interface is asking for the instrument's price, in the currency the
    ///      instrument is denominated in, and would have no way to know a
    ///      tinybar answer had been substituted. The composite has its own name.
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "Lattice Prime LPRC clean price / USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return getRoundData(uint80(lastRound));
    }

    /// @dev Reverts on an unfinalised round, which is Chainlink's own
    ///      convention: a feed that answered zero for a round it does not have
    ///      would be indistinguishable from a feed that thinks the price is
    ///      zero.
    ///
    ///      `startedAt` and `updatedAt` are the same instant here and that is
    ///      not a shortcut. A round in this contract is opened by whoever
    ///      submits first and closed by whoever finalises, and the open is not a
    ///      price; the only timestamp at which this feed held an answer is the
    ///      one `finalize` landed in.
    function getRoundData(uint80 roundId)
        public
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        // Safe: rounds are counted in a `uint64` and `uint80` is wider, so a
        // round id above the last one simply has no data.
        // forge-lint: disable-next-line(unsafe-typecast)
        Round storage r = _rounds[uint64(roundId)];
        if (r.publishedAt == 0) revert NoData();
        return (
            roundId, int256(uint256(r.price)), r.publishedAt, r.publishedAt, roundId
        );
    }

    // ---------------------------------------------------------- governance

    /// @notice Propose the next panel. Adoptable next epoch.
    /// @dev One idiom, two seats: this and `proposeCashFeed` both wait an epoch,
    ///      the way `ZkKycRegistry.proposeGate` and `ParameterRoot.propose`
    ///      already do, so a change to who prices this venue is visible before
    ///      it binds rather than after it has been used.
    function proposePublishers(address[] calldata next) external {
        if (msg.sender != admin) revert NotAdmin();
        _requireWellFormedPanel(next);

        delete _pendingPanel;
        for (uint256 i; i < next.length; ++i) {
            _pendingPanel.push(next[i]);
        }
        pendingPanelEpoch = policy.currentEpoch() + 1;
        emit PanelProposed(pendingPanelEpoch, next.length);
    }

    /// @notice Seat the proposed panel once its epoch has arrived. Permissionless.
    function adoptPublishers() external {
        if (pendingPanelEpoch == 0) revert NothingPending();
        uint64 e = policy.currentEpoch();
        if (e < pendingPanelEpoch) revert NotYetEffective(pendingPanelEpoch, e);

        address[] memory next = _pendingPanel;
        _seat(next);
        delete _pendingPanel;
        pendingPanelEpoch = 0;
        emit PanelAdopted(e, next.length);
    }

    function proposeCashFeed(AggregatorV3Interface next) external {
        if (msg.sender != admin) revert NotAdmin();
        _requireEightDecimals(next);
        pendingCashFeed = next;
        pendingCashFeedEpoch = policy.currentEpoch() + 1;
        emit CashFeedProposed(address(next), pendingCashFeedEpoch);
    }

    function adoptCashFeed() external {
        if (pendingCashFeedEpoch == 0) revert NothingPending();
        uint64 e = policy.currentEpoch();
        if (e < pendingCashFeedEpoch) revert NotYetEffective(pendingCashFeedEpoch, e);

        // Re-read rather than trust the check made at proposal time. A proxy
        // repointed between the two calls is exactly the case this catches.
        _requireEightDecimals(pendingCashFeed);
        cashFeed = pendingCashFeed;
        pendingCashFeed = AggregatorV3Interface(address(0));
        pendingCashFeedEpoch = 0;
        emit CashFeedAdopted(address(cashFeed), e);
    }

    // ------------------------------------------------------------- internals

    function _seat(address[] memory next) private {
        for (uint256 i; i < _panel.length; ++i) {
            seated[_panel[i]] = false;
        }
        delete _panel;
        for (uint256 i; i < next.length; ++i) {
            seated[next[i]] = true;
            _panel.push(next[i]);
        }
        // Last, so the open round is abandoned by the same call that changes who
        // may answer it. See `generation`.
        ++generation;
    }

    /// @dev Bounded twice over, and the second bound is the one that matters: a
    ///      panel below quorum is a feed that can never finalise a round, which
    ///      is a dark feed that looks configured.
    function _requireWellFormedPanel(address[] memory next) private view {
        if (next.length < quorum || next.length > maxPublishers) {
            revert PanelSize(next.length, quorum, maxPublishers);
        }
        for (uint256 i; i < next.length; ++i) {
            if (next[i] == address(0)) revert PanelNotDistinct(address(0));
            for (uint256 j; j < i; ++j) {
                if (next[i] == next[j]) revert PanelNotDistinct(next[i]);
            }
        }
    }

    /// @dev Refused rather than scaled. Normalising an arbitrary decimals field
    ///      means carrying a second scale through every multiply in this
    ///      contract and in `tools/units.mjs`, to accommodate a feed that does
    ///      not exist: all seven Chainlink feeds on Hedera answer with eight.
    function _requireEightDecimals(AggregatorV3Interface f) private view {
        uint8 d = f.decimals();
        if (d != DECIMALS) revert FeedDecimals(d, DECIMALS);
    }
}
