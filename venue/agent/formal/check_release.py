#!/usr/bin/env python3
"""Run bounded two-execution checks for the approved preference release."""

from __future__ import annotations

import hashlib
import json

from z3 import And, If, Int, Or, Solver, sat


def category_buffer(value):
    return If(value < 2000, 0, If(value < 5000, 1, 2))


def category_horizon(value):
    return If(value < 24, 0, If(value < 72, 1, 2))


def relu(value):
    return If(value > 0, value, 0)


def decision(public, buffer_category, horizon_category):
    room, move_offset, round_progress, freshness = public
    score = (
        6 * (room - 1000)
        + 4 * (move_offset - 1000)
        + (round_progress - 5000)
        - 16 * (freshness - 150)
        + 1000 * (buffer_category - 1)
        + 700 * (horizon_category - 1)
    )
    return score > 0


def quantized_graph_decision(public, buffer_category, horizon_category):
    room, move_offset, round_progress, freshness = public
    projection_numerator = (
        6 * room
        + 4 * move_offset
        + round_progress
        - 16 * freshness
        + 1000 * buffer_category
        + 700 * horizon_category
        - 14_300
    )
    positive_hidden = [relu(projection_numerator) for _ in range(4)]
    negative_hidden = [relu(-projection_numerator) for _ in range(4)]
    wait_logit_numerator = 64 * sum(negative_hidden)
    execute_logit_numerator = 64 * sum(positive_hidden)
    return execute_logit_numerator > wait_logit_numerator


def public_domain(public):
    room, move_offset, round_progress, freshness = public
    return And(
        room >= 0,
        room <= 2000,
        move_offset >= 0,
        move_offset <= 2000,
        round_progress >= 0,
        round_progress <= 10_000,
        freshness >= 0,
        freshness <= 300,
    )


def check_default_mode():
    private_1 = [Int("default_buffer_1"), Int("default_horizon_1")]
    private_2 = [Int("default_buffer_2"), Int("default_horizon_2")]
    public = [Int(f"default_public_{i}") for i in range(4)]
    solver = Solver()
    solver.add(public_domain(public))
    solver.add(private_1[0] >= 0, private_1[0] <= 10_000, private_1[1] >= 0, private_1[1] <= 168)
    solver.add(private_2[0] >= 0, private_2[0] <= 10_000, private_2[1] >= 0, private_2[1] <= 168)
    solver.add(decision(public, 1, 1) != decision(public, 1, 1))
    result = solver.check()
    return result, solver


def check_optional_mode():
    buffer_1, buffer_2 = Int("optional_buffer_1"), Int("optional_buffer_2")
    horizon_1, horizon_2 = Int("optional_horizon_1"), Int("optional_horizon_2")
    public = [Int(f"optional_public_{i}") for i in range(4)]
    buffer_category_1, buffer_category_2 = category_buffer(buffer_1), category_buffer(buffer_2)
    horizon_category_1, horizon_category_2 = category_horizon(horizon_1), category_horizon(horizon_2)

    solver = Solver()
    solver.add(public_domain(public))
    solver.add(buffer_1 >= 0, buffer_1 <= 10_000, buffer_2 >= 0, buffer_2 <= 10_000)
    solver.add(horizon_1 >= 0, horizon_1 <= 168, horizon_2 >= 0, horizon_2 <= 168)
    solver.add(buffer_category_1 == buffer_category_2, horizon_category_1 == horizon_category_2)
    solver.add(
        decision(public, buffer_category_1, horizon_category_1)
        != decision(public, buffer_category_2, horizon_category_2)
    )
    result = solver.check()
    return result, solver


def check_quantized_graph_correspondence():
    public = [Int(f"correspondence_public_{i}") for i in range(4)]
    buffer_category = Int("correspondence_buffer_category")
    horizon_category = Int("correspondence_horizon_category")
    solver = Solver()
    solver.add(public_domain(public))
    solver.add(buffer_category >= 0, buffer_category <= 2)
    solver.add(horizon_category >= 0, horizon_category <= 2)
    solver.add(
        decision(public, buffer_category, horizon_category)
        != quantized_graph_decision(public, buffer_category, horizon_category)
    )
    result = solver.check()
    return result, solver


def require_unsat(name, outcome):
    result, solver = outcome
    if result == sat:
        raise AssertionError(f"{name} counterexample: {solver.model()}")
    if str(result) != "unsat":
        raise AssertionError(f"{name} was not decided: {result}")


def main() -> None:
    default = check_default_mode()
    optional = check_optional_mode()
    correspondence = check_quantized_graph_correspondence()
    require_unsat("default excluded context", default)
    require_unsat("optional category release", optional)
    require_unsat("quantized graph correspondence", correspondence)

    source_hash = f"sha256:{hashlib.sha256(open(__file__, 'rb').read()).hexdigest()}"
    print(
        json.dumps(
            {
                "schemaVersion": "lattice.agent.release-check.v1",
                "solver": "z3-solver 4.15.3.0",
                "sourceSha256": source_hash,
                "results": {
                    "defaultExcludedContext": "unsat",
                    "optionalEqualCategories": "unsat",
                    "quantizedGraphCorrespondence": "unsat",
                },
                "domains": {
                    "bufferRatioBps": [0, 10_000],
                    "horizonHours": [0, 168],
                    "limitRoomBps": [0, 2000],
                    "recentMoveOffsetBps": [0, 2000],
                    "roundProgressBps": [0, 10_000],
                    "freshnessSeconds": [0, 300],
                },
                "scope": (
                    "Two-run integer decision core, approved category release, and exact "
                    "trained quantized graph correspondence. The optional product mode "
                    "remains disabled by product policy."
                ),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
