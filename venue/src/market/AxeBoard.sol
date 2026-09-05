// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {AxeGrid} from "./AxeGrid.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @dev Narrow read of the book so the board does not enlarge `MatchingEngine`.
interface ISealedOrderBook {
    function commitBond() external view returns (uint256);

    function commitments(bytes32 id)
        external
        view
        returns (
            address committer,
            uint64 committedAt,
            bool revealed,
            bool cancelled,
            uint256 bond
        );
}

interface IRespondentRegistry {
    /// @return FIX 1172: 1 participant, 3 market maker, 4 primary.
    function respondentType(address who) external view returns (uint8);
}

/// @title AxeBoard
/// @notice Lender posts a sealed grid; borrower learns one bit.
/// @dev Row 13 is charged at `probe` (Rule C) because the bit is learned from
///      the opening, not the log. `answer` never re-checks. `discharge` cannot
///      prove the sealed order sits in the probed cell without a reveal.
contract AxeBoard is DisclosureView {
    enum Respondent {
        ALL,
        SPECIFIED,
        MARKET_MAKERS,
        PRIMARY
    }

    enum Status {
        NONE,
        OPEN,
        CLOSED,
        INDICATED,
        DISCHARGED,
        SLASHED
    }

    struct Axe {
        address lender;
        uint64 postedAt;
        uint64 goodUntil;
        bytes32 grid;
        bytes32 respondents;
        Respondent respondent;
        bool privateQuote;
        bool withdrawn;
        bool slashed;
        uint32 outstanding;
        uint256 bond;
    }

    struct Probe {
        bytes32 axeId;
        address prober;
        uint64 askedAt;
        uint64 answeredAt;
        uint16 cell;
        Status status;
        uint256 fee;
    }

    bytes32 public constant DOMAIN_AXE = keccak256("hedera2026.axeboard.axe.v1");
    bytes32 public constant DOMAIN_PROBE = keccak256("hedera2026.axeboard.probe.v1");
    bytes32 public constant DOMAIN_MEMBER = keccak256("hedera2026.axeboard.member.v1");
    bytes32 public constant DOMAIN_PAIR = keccak256("hedera2026.axeboard.pair.v1");

    uint8 internal constant FIX_MARKET_MAKER = 3;
    uint8 internal constant FIX_PRIMARY = 4;

    ISealedOrderBook public immutable book;
    IRespondentRegistry public immutable registry;
    uint256 public immutable axeBond;
    uint256 public immutable probeFee;
    uint64 public immutable answerWindow;
    uint64 public immutable osrWindow;
    uint32 public immutable maxOutstanding;

    mapping(bytes32 => Axe) public axes;
    mapping(bytes32 => Probe) public probes;
    mapping(address => uint256) public credit;

    uint16 internal constant ROW_ORDER_SIZE = 3;
    uint16 internal constant ROW_ORDER_PRICE = 4;
    uint16 internal constant ROW_MATCH_PREDICATE = 13;
    uint16 internal constant ROW_ACTIVITY = 15;
    uint16 internal constant ROW_PROVENANCE = 17;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    function _enter() private {
        require(_lock == 1, "reentrant");
        _lock = 2;
    }

    function _exit() private {
        _lock = 1;
    }

    event AxePosted(
        bytes32 indexed axeId, address indexed lender, uint8 respondentType, uint64 goodUntil
    );
    event AxeWithdrawn(bytes32 indexed axeId);
    event AxeSlashed(bytes32 indexed axeId, bytes32 indexed probeId, uint256 amount);
    event AxeReclaimed(bytes32 indexed axeId, uint256 amount);
    event Probed(
        bytes32 indexed probeId, bytes32 indexed axeId, address indexed prober, uint16 cell
    );
    event Answered(bytes32 indexed probeId, bool covered);
    event Discharged(bytes32 indexed probeId, bytes32 orderId);
    event Withdrawn(address indexed who, uint256 amount);

    error WrongBond(uint256 sent, uint256 want);
    error WrongFee(uint256 sent, uint256 want);
    error EmptyGrid();
    error AlreadyPosted(bytes32 axeId);
    error UnknownAxe(bytes32 axeId);
    error UnknownProbe(bytes32 probeId);
    error AlreadyProbed(bytes32 probeId);
    error NotLender(address lender);
    error NotProber(address prober);
    error AxeIsDead(bytes32 axeId);
    error AxeWasWithdrawn(bytes32 axeId);
    error AxeHasExpired(uint64 goodUntil);
    error AxeStillGood(uint64 goodUntil);
    error BadCell(uint16 cell);
    error TooManyOutstanding(uint32 cap);
    error NotARespondent(address who);
    error NoRespondentSet();
    error RespondentSetUnused();
    error RespondentRegistryNotAttached();
    error ProbeNotOpen(Status status);
    error ProbeNotIndicated(Status status);
    error AnswerWindowClosed(uint64 closedAt);
    error OsrWindowClosed(uint64 closedAt);
    error OpeningDoesNotMatch();
    error NotYetSlashable(uint64 due);
    error NotSlashable(Status status);
    error ProbesOutstanding(uint32 count);
    error NothingToReclaim();
    error NothingToWithdraw();
    error OrderIsNotTheLenders(address committer);
    error OrderWasCancelled(bytes32 orderId);
    error OrderPredatesTheIndication(uint64 committedAt, uint64 answeredAt);
    error ZeroOutstandingCap();
    error AxeBondTooLow(uint256 bond, uint256 minimum);
    error ZeroWindow();
    error PredicateBudgetExhausted(uint16 row, uint32 spent, uint32 budget);

    constructor(
        ISealedOrderBook book_,
        IRespondentRegistry registry_,
        IDisclosurePolicy policy_,
        uint256 probeFee_,
        uint256 axeBond_,
        uint64 answerWindow_,
        uint64 osrWindow_,
        uint32 maxOutstanding_
    ) DisclosureView(policy_) {
        if (maxOutstanding_ == 0) revert ZeroOutstandingCap();
        if (answerWindow_ == 0 || osrWindow_ == 0) revert ZeroWindow();
        uint256 floor_ = minimumAxeBond(book_.commitBond(), probeFee_, maxOutstanding_);
        if (axeBond_ < floor_) revert AxeBondTooLow(axeBond_, floor_);

        book = book_;
        registry = registry_;
        probeFee = probeFee_;
        axeBond = axeBond_;
        answerWindow = answerWindow_;
        osrWindow = osrWindow_;
        maxOutstanding = maxOutstanding_;
    }

    /// @dev `M * (commitBond - probeFee) + 1` when the fee does not already
    ///      cover the commit bond. Binding case is k = M concurrent yes-answers.
    function minimumAxeBond(uint256 commitBond_, uint256 probeFee_, uint32 maxOutstanding_)
        public
        pure
        returns (uint256)
    {
        if (probeFee_ >= commitBond_) return 1;
        return uint256(maxOutstanding_) * (commitBond_ - probeFee_) + 1;
    }

    function fixTag1172(Respondent r) public pure returns (uint8) {
        return uint8(r) + 1;
    }

    function axeIdOf(address lender, bytes32 grid, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_AXE, lender, grid, salt));
    }

    function probeIdOf(bytes32 axeId, address prober, uint16 cell)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_PROBE, axeId, prober, cell));
    }

    function postAxe(
        bytes32 grid,
        bytes32 salt,
        uint64 goodUntil,
        Respondent respondent,
        bytes32 respondents,
        bool privateQuote
    ) external payable returns (bytes32 axeId) {
        if (msg.value != axeBond) revert WrongBond(msg.value, axeBond);
        if (grid == bytes32(0)) revert EmptyGrid();
        if (goodUntil <= block.timestamp) revert AxeHasExpired(goodUntil);
        if (respondent == Respondent.SPECIFIED) {
            if (respondents == bytes32(0)) revert NoRespondentSet();
        } else {
            if (respondents != bytes32(0)) revert RespondentSetUnused();
            if (respondent != Respondent.ALL && address(registry) == address(0)) {
                revert RespondentRegistryNotAttached();
            }
        }

        axeId = axeIdOf(msg.sender, grid, salt);
        if (axes[axeId].lender != address(0)) revert AlreadyPosted(axeId);

        axes[axeId] = Axe({
            lender: msg.sender,
            postedAt: uint64(block.timestamp),
            goodUntil: goodUntil,
            grid: grid,
            respondents: respondents,
            respondent: respondent,
            privateQuote: privateQuote,
            withdrawn: false,
            slashed: false,
            outstanding: 0,
            bond: msg.value
        });

        if (!privateQuote && _emitUnder(axeId, ROW_PROVENANCE, L.G_EXACT, L.T_IMM)) {
            emit AxePosted(axeId, msg.sender, fixTag1172(respondent), goodUntil);
        }
    }

    function withdrawAxe(bytes32 axeId) external {
        Axe storage a = axes[axeId];
        if (a.lender == address(0)) revert UnknownAxe(axeId);
        if (a.lender != msg.sender) revert NotLender(a.lender);
        if (a.slashed) revert AxeIsDead(axeId);
        if (a.withdrawn) revert AxeWasWithdrawn(axeId);
        a.withdrawn = true;
        if (_emitUnder(axeId, ROW_ACTIVITY, L.G_PRED, L.T_IMM)) {
            emit AxeWithdrawn(axeId);
        }
    }

    function reclaimAxe(bytes32 axeId) external {
        Axe storage a = axes[axeId];
        if (a.lender == address(0)) revert UnknownAxe(axeId);
        if (a.outstanding != 0) revert ProbesOutstanding(a.outstanding);
        if (!a.withdrawn && block.timestamp < a.goodUntil) revert AxeStillGood(a.goodUntil);
        uint256 bond = a.bond;
        if (bond == 0) revert NothingToReclaim();
        a.bond = 0;
        credit[a.lender] += bond;
        emit AxeReclaimed(axeId, bond);
    }

    function probe(
        bytes32 axeId,
        uint16 cell,
        bytes32 memberSalt,
        bytes32[] calldata respondentProof
    ) external payable returns (bytes32 probeId) {
        Axe storage a = axes[axeId];
        if (a.lender == address(0)) revert UnknownAxe(axeId);
        if (a.slashed) revert AxeIsDead(axeId);
        if (a.withdrawn) revert AxeWasWithdrawn(axeId);
        if (block.timestamp >= a.goodUntil) revert AxeHasExpired(a.goodUntil);
        if (cell >= AxeGrid.CELL_CARD) revert BadCell(cell);
        if (msg.value != probeFee) revert WrongFee(msg.value, probeFee);
        if (a.outstanding >= maxOutstanding) revert TooManyOutstanding(maxOutstanding);
        if (!_mayProbe(a, msg.sender, memberSalt, respondentProof)) {
            revert NotARespondent(msg.sender);
        }

        probeId = probeIdOf(axeId, msg.sender, cell);
        if (probes[probeId].prober != address(0)) revert AlreadyProbed(probeId);

        _incurUnder(probeId, ROW_MATCH_PREDICATE, L.G_PRED, L.T_IMM);

        probes[probeId] = Probe({
            axeId: axeId,
            prober: msg.sender,
            askedAt: uint64(block.timestamp),
            answeredAt: 0,
            cell: cell,
            status: Status.OPEN,
            fee: msg.value
        });
        a.outstanding += 1;

        _announce(probeId, axeId, cell);
    }

    function _announce(bytes32 probeId, bytes32 axeId, uint16 cell) private {
        bool okSize = _emitUnder(probeId, ROW_ORDER_SIZE, L.G_BUCKET, L.T_IMM);
        bool okRate = _emitUnder(probeId, ROW_ORDER_PRICE, L.G_BUCKET, L.T_IMM);
        bool okWho = _emitUnder(probeId, ROW_PROVENANCE, L.G_EXACT, L.T_IMM);
        if (okSize && okRate && okWho) {
            emit Probed(probeId, axeId, msg.sender, cell);
        }
    }

    function answer(bytes32 probeId, bool covered, bytes32 salt, bytes32[] calldata proof)
        external
    {
        Probe storage p = probes[probeId];
        if (p.prober == address(0)) revert UnknownProbe(probeId);
        if (p.status != Status.OPEN) revert ProbeNotOpen(p.status);
        Axe storage a = axes[p.axeId];
        if (a.lender != msg.sender) revert NotLender(a.lender);

        uint64 closesAt = p.askedAt + answerWindow;
        if (block.timestamp > closesAt) revert AnswerWindowClosed(closesAt);

        if (!AxeGrid.verify(a.grid, p.cell, covered, salt, proof)) revert OpeningDoesNotMatch();

        p.answeredAt = uint64(block.timestamp);
        if (covered) {
            p.status = Status.INDICATED;
        } else {
            p.status = Status.CLOSED;
            a.outstanding -= 1;
        }

        uint256 fee = p.fee;
        if (fee != 0) {
            p.fee = 0;
            credit[a.lender] += fee;
        }

        emit Answered(probeId, covered);
    }

    function discharge(bytes32 probeId, bytes32 orderId) external {
        Probe storage p = probes[probeId];
        if (p.prober == address(0)) revert UnknownProbe(probeId);
        if (p.status != Status.INDICATED) revert ProbeNotIndicated(p.status);
        Axe storage a = axes[p.axeId];
        if (a.lender != msg.sender) revert NotLender(a.lender);

        uint64 closesAt = p.answeredAt + osrWindow;
        if (block.timestamp > closesAt) revert OsrWindowClosed(closesAt);

        (address committer, uint64 committedAt,, bool cancelled,) = book.commitments(orderId);
        if (committer != a.lender) revert OrderIsNotTheLenders(committer);
        if (cancelled) revert OrderWasCancelled(orderId);
        if (committedAt < p.answeredAt) {
            revert OrderPredatesTheIndication(committedAt, p.answeredAt);
        }

        p.status = Status.DISCHARGED;
        a.outstanding -= 1;
        if (_emitUnder(probeId, ROW_ACTIVITY, L.G_PRED, L.T_IMM)) {
            emit Discharged(probeId, orderId);
        }
    }

    function slash(bytes32 probeId) external {
        Probe storage p = probes[probeId];
        if (p.prober == address(0)) revert UnknownProbe(probeId);
        Axe storage a = axes[p.axeId];

        uint64 due;
        if (p.status == Status.OPEN) {
            due = p.askedAt + answerWindow;
        } else if (p.status == Status.INDICATED) {
            due = p.answeredAt + osrWindow;
        } else {
            revert NotSlashable(p.status);
        }
        if (block.timestamp <= due) revert NotYetSlashable(due);

        p.status = Status.SLASHED;
        a.outstanding -= 1;
        a.slashed = true;

        uint256 take = a.bond;
        a.bond = 0;
        uint256 fee = p.fee;
        p.fee = 0;
        credit[p.prober] += take + fee;

        if (_emitUnder(probeId, ROW_ACTIVITY, L.G_PRED, L.T_IMM)) {
            emit AxeSlashed(p.axeId, probeId, take);
        }
    }

    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function _mayProbe(
        Axe storage a,
        address who,
        bytes32 memberSalt,
        bytes32[] calldata proof
    ) private view returns (bool) {
        Respondent r = a.respondent;
        if (r == Respondent.ALL) return true;
        if (r == Respondent.SPECIFIED) {
            return _memberOf(a.respondents, who, memberSalt, proof);
        }
        uint8 level = _respondentLevel(who);
        if (r == Respondent.MARKET_MAKERS) return level >= FIX_MARKET_MAKER;
        return level >= FIX_PRIMARY;
    }

    /// @dev Sorted-pair tree over salted members. Bare addresses would enumerate
    ///      at this venue's counterparty count.
    function _memberOf(
        bytes32 root,
        address who,
        bytes32 memberSalt,
        bytes32[] calldata proof
    ) private pure returns (bool) {
        if (root == bytes32(0)) return false;
        bytes32 h = keccak256(abi.encode(DOMAIN_MEMBER, who, memberSalt));
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 s = proof[i];
            h = h <= s
                ? keccak256(abi.encode(DOMAIN_PAIR, h, s))
                : keccak256(abi.encode(DOMAIN_PAIR, s, h));
        }
        return h == root;
    }

    function _respondentLevel(address who) private view returns (uint8) {
        (bool ok, bytes memory out) = address(registry)
            .staticcall(abi.encodeCall(IRespondentRegistry.respondentType, (who)));
        if (!ok || out.length != 32) return 0;
        uint256 v = abi.decode(out, (uint256));
        if (v > type(uint8).max) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(v);
    }

    function _incurUnder(bytes32 id, uint16 row, uint8 g, uint8 t) internal {
        uint32 over = L.excess(policy.ceilingFor(row), L.point(g, t));
        if (over != 0) {
            emit DisclosureRefused(id, row, over);
            revert DisclosureExceedsCeiling(row, over);
        }
        if (!DisclosureMeter.spend(_meter, policy, row, g)) {
            B.Row memory r = policy.budgetFor(row);
            revert PredicateBudgetExhausted(
                row, DisclosureMeter.spentBits(_meter, row, policy.currentEpoch()), r.budgetBits
            );
        }
    }

    function indicationsLeft() external view returns (uint256) {
        B.Row memory r = policy.budgetFor(ROW_MATCH_PREDICATE);
        if (r.budgetBits == 0) return type(uint256).max;
        uint32 spent =
            DisclosureMeter.spentBits(_meter, ROW_MATCH_PREDICATE, policy.currentEpoch());
        if (spent >= r.budgetBits) return 0;
        return (r.budgetBits - spent) / B.bits(r, L.G_PRED);
    }

    function indicationOf(bytes32 probeId)
        external
        view
        returns (Status status, bool covered)
    {
        Probe storage p = probes[probeId];
        return (p.status, p.status == Status.INDICATED || p.status == Status.DISCHARGED);
    }

    function slashableAfter(bytes32 probeId) external view returns (uint64) {
        Probe storage p = probes[probeId];
        if (p.status == Status.OPEN) return p.askedAt + answerWindow;
        if (p.status == Status.INDICATED) return p.answeredAt + osrWindow;
        return 0;
    }

    function cellFor(uint8 classId, uint256 lot, uint256 rateBps)
        external
        pure
        returns (uint16)
    {
        return AxeGrid.cellFor(classId, lot, rateBps);
    }

    function gridRootOf(
        uint8 classId,
        uint256 sizeLo,
        uint256 sizeHi,
        uint256 rateLoBps,
        uint256 rateHiBps,
        bytes32 master
    ) external pure returns (bytes32) {
        return AxeGrid.rootOf(
            AxeGrid.bandRect(classId, sizeLo, sizeHi, rateLoBps, rateHiBps), master
        );
    }

    function openingFor(
        uint8 classId,
        uint256 sizeLo,
        uint256 sizeHi,
        uint256 rateLoBps,
        uint256 rateHiBps,
        bytes32 master,
        uint16 cell
    ) external pure returns (bool covered, bytes32 salt, bytes32[] memory proof) {
        return AxeGrid.openingOf(
            AxeGrid.bandRect(classId, sizeLo, sizeHi, rateLoBps, rateHiBps), master, cell
        );
    }
}
