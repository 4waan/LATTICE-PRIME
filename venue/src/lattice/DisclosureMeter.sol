// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureBudget as B} from "./DisclosureBudget.sol";
import {DisclosureLattice as L} from "./DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @title DisclosureMeter
/// @notice The coalition budget, spent at the point of disclosure rather than
///         checked offline against a matrix.
///
/// ## Why this file exists
///
/// `DisclosureBudget` is the only object in the venue that can detect emergent
/// collusion, and its own header proves why the lattice cannot: a coalition's
/// knowledge is a union of ideals, a ceiling is an ideal, and a union of subsets
/// of a set is a subset of that set. Every observer individually under the
/// ceiling means the coalition is under it, always.
///
/// Before this file, that library ran in exactly one contract. `SeamJournal`
/// spends from a single row's budget held as a constructor argument.
/// `OrderBook` and `RepoVault`, which between them disclose on rows 3, 4, 5, 7,
/// 14, 16 and 17, called `_emitUnder` and checked **only** the ceiling. So the
/// deployed venue enforced the half of the model that provably cannot see
/// collusion, and the half that can was a Python script over a document.
///
/// Worse, the two disagreed. `DisclosureLattice`'s header records that
/// `scripts/collusion-check.py` computes a lex join which is wrong in the
/// direction that produces false negatives, with a witness in
/// `test_lexJoinUnderReports`. The join that ships in the pitch is the wrong one.
///
/// This library is the one code path, and the budget is a governed parameter read
/// beside the ceiling rather than a deploy constant, for the reason
/// `IDisclosurePolicy` exists at all: a bound nobody can read off a published
/// root is a bound nobody can audit.
///
/// ## Rule A. Exhaustion withholds the disclosure. It never fails the action.
///
/// This is `SeamJournal`'s semantics, adopted unchanged and for its reason: *a
/// compliant transfer must not revert because the venue has run out of things it
/// may say.* The alternative was tried and discarded during this build. Charging
/// at emission and reverting hands an attacker a denial of service, because
/// nearly every disclosure in a repo lifecycle sits on an obligation path:
/// exhaust a row's budget with cheap disclosing actions and margin calls cannot
/// be recorded, coupons cannot be paid through and open positions cannot be
/// closed. Classifying each call site as refusable or compelled was the second
/// attempt, and it fails differently: the classification is a judgement made per
/// call site, so it is exactly the kind of thing that drifts silently, and the
/// audit would have to be redone on every new entry point.
///
/// Withholding has neither problem. The state transition always completes; only
/// the venue's speech is rationed.
///
/// **The scope this fixes, stated because it is narrower than the word budget
/// suggests.** The meter bounds the venue's **event stream**. It does not bound
/// storage. `RepoVault._emitUnder` already records this limit for the ceiling,
/// and `repo(id)` still returns fourteen fields in the clear to any caller; the
/// budget inherits the limit unchanged. On a public ledger a contract that can
/// read a number is a contract whose storage anyone can read, which is the same
/// observation `OrderBook` makes when it collapses `{ven}` into `{pub}`. What the
/// meter genuinely bounds is the indexed, ordered, supervisor-facing channel that
/// a coalition actually consumes, and that is worth bounding. It is not a claim
/// that the value became unreachable.
///
/// ## Rule B. A row whose ceiling admits an exact disclosure carries no budget.
///
/// `DisclosureBudget.requireWellFormed` demands `budgetBits < domainBits`, and
/// `bits(row, G_EXACT)` **is** `domainBits`. So a single exact disclosure exceeds
/// any well formed budget on its own, always. `SeamJournal` already records this
/// as a theorem for its own row.
///
/// The consequence for a governed matrix is sharper than that file needed. Under
/// Rule A an unaffordable disclosure is withheld, so attaching a budget to a row
/// the venue discloses exactly would not refuse a transaction, it would **silence
/// that row permanently**, on every call, for every epoch. A ceiling admitting
/// `(exact, imm)` is the venue declaring that row fully public, so
/// `ParameterRoot.adopt` refuses a set that pairs the two. The pairing is
/// un-adoptable rather than inert, because a bound that can never bind would
/// certify a limit that does not hold.
///
/// So an unmetered row is not a hole. It is the published ceiling restated:
/// **the meter binds exactly the rows the venue does not already publish
/// exactly**, and a reader can tell which those are from the committed root.
///
/// The first result of running this over the deployed matrix was a finding
/// rather than a pass. Every cell `OrderBook` disclosed was at `G_EXACT`, so the
/// book was unmeterable by construction and no budget parameter could change it.
/// The lever that leaves is a coarser disclosure, not a tighter bound.
/// `test_theBooksExactRowsAreUnmeterableByConstruction` pins the half still true.
///
/// **That lever has since been taken, by a new entry point rather than a new
/// parameter.** `OrderBook.cancel` publishes row 15 at `(pred, imm)`, one bit,
/// the book's first cell below `G_EXACT` and so the first a budget can bind.
/// Worth stating plainly because it says what this library is for: a meter is
/// not something to attach to a venue that publishes everything exactly, it is a
/// reason to publish something coarsely.
///
/// ## What this costs
///
/// One `SLOAD` of the packed budget, one of the cell, one comparison and one
/// `SSTORE` per charged disclosure. The arithmetic is `uint16` addition. The
/// lattice half it sits beside is a measured 42 gas. Collusion is cheap; cost was
/// never what kept it offline.
library DisclosureMeter {
    /// @notice Bits spent against one row's budget in one epoch.
    /// @dev Keyed `row << 64 | epoch` rather than nested mappings, so a caller
    ///      holds one field and the whole meter is one slot per (row, epoch).
    struct Meter {
        mapping(uint256 => uint32) spent;
    }

    /// @notice A disclosure was charged against a row's epoch budget.
    /// @dev The join over an epoch is the sum of these, which is what makes the
    ///      collusion check readable from the chain instead of from a script over
    ///      a document. Carries no value, only the row, the level and the cost.
    event DisclosureCharged(
        uint16 indexed row, uint64 indexed epoch, uint8 granularity, uint32 cost, uint32 spentAfter
    );

    function _key(uint16 row, uint64 epoch) private pure returns (uint256) {
        return (uint256(row) << 64) | uint256(epoch);
    }

    /// @notice Bits already spent on `row` in `epoch`.
    /// @dev The supervisor's read, and the one that makes withholding visible.
    ///      A silenced row and a quiet row look identical in the event stream by
    ///      construction, so the distinction has to live in a view.
    function spentBits(Meter storage m, uint16 row, uint64 epoch)
        internal
        view
        returns (uint32)
    {
        return m.spent[_key(row, epoch)];
    }

    /// @notice Whether `row` carries a binding budget at all.
    /// @dev `budgetBits == 0` reads "governance published no bound for this row",
    ///      never "the bound is zero": `requireWellFormed` refuses
    ///      `budgetBits >= domainBits` and `adopt` refuses a budget on a row whose
    ///      ceiling admits exact.
    function isMetered(IDisclosurePolicy policy, uint16 row) internal view returns (bool) {
        return policy.budgetFor(row).budgetBits != 0;
    }

    /// @notice What one disclosure at granularity `g` costs on `row`. Zero when
    ///         the row is unmetered.
    function costOf(IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (uint32)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return 0;
        return B.bits(r, g);
    }

    /// @notice Whether a disclosure at `g` would be afforded on `row` right now.
    /// @dev A view, so a client can ask before it sends a transaction whose
    ///      disclosure would be silently withheld. `wouldDisclose` on the
    ///      disclosing contracts answers the ceiling half; a caller needs both,
    ///      and the two answer different questions: the ceiling asks whether the
    ///      venue **may** say it, this asks whether it can still **afford** to.
    function wouldAfford(Meter storage m, IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (bool)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return true;
        uint32 already = m.spent[_key(row, policy.currentEpoch())];
        return already + B.bits(r, g) <= r.budgetBits;
    }

    /// @notice Charge one disclosure at `g` against `row`'s epoch budget.
    /// @return afforded True when the budget covered it and the caller should
    ///         emit. False when the row is spent and the caller must withhold.
    /// @dev Rule A. This never reverts, and the caller must not turn a `false`
    ///      into one. An unmetered row always affords, so a contract disclosing
    ///      only on unmetered rows behaves exactly as it did before this library
    ///      existed, which is what makes the wiring safe to add everywhere at
    ///      once.
    function spend(Meter storage m, IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        returns (bool afforded)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return true; // unmetered, Rule B
        uint64 e = policy.currentEpoch();
        uint256 k = _key(row, e);
        uint32 cost = B.bits(r, g);
        uint32 already = m.spent[k];
        if (already + cost > r.budgetBits) return false;
        uint32 next = already + cost;
        m.spent[k] = next;
        emit DisclosureCharged(row, e, g, cost, next);
        return true;
    }

    /// @notice The smallest number of disclosures at `g` that exhausts `row`.
    /// @dev `DisclosureBudget.breakingSize` against the governed parameter rather
    ///      than a struct the caller supplied. The number a supervisor asks for:
    ///      how many observations before this row is gone. Zero when unmetered.
    function breakingSize(IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (uint256)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return 0;
        return B.breakingSize(r, g);
    }

    /// @notice Rule B as a predicate, so `ParameterRoot` and the tests ask it the
    ///         same way.
    /// @dev `point(G_EXACT, T_IMM)` generates every granularity at every time from
    ///      `imm` onward, so a ceiling containing it is one under which the venue
    ///      may publish the exact value as soon as it exists.
    function ceilingAdmitsExact(uint32 ceiling) internal pure returns (bool) {
        return L.permits(ceiling, L.point(L.G_EXACT, L.T_IMM));
    }
}
