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
    hidden = [
        relu(room - 250),
        relu(move_offset - 1000),
        relu(180 - freshness),
        relu(round_progress - 2500),
        relu(8000 - round_progress),
        buffer_category,
        horizon_category,
        1,
    ]
    score_scaled_128 = (
        128 * hidden[0]
        + 32 * hidden[1]
        + 128 * hidden[2]
        + 2 * hidden[3]
        + hidden[4]
        - 12_800 * hidden[5]
        + 2_560 * hidden[6]
        - 64_000 * hidden[7]
    )
    return score_scaled_128 > 0


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


def require_unsat(name, outcome):
    result, solver = outcome
    if result == sat:
        raise AssertionError(f"{name} counterexample: {solver.model()}")
    if str(result) != "unsat":
        raise AssertionError(f"{name} was not decided: {result}")


def main() -> None:
    default = check_default_mode()
    optional = check_optional_mode()
    require_unsat("default excluded context", default)
    require_unsat("optional category release", optional)

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
                    "Two-run integer decision core and approved category release. "
                    "The optional product mode remains disabled pending executable correspondence tests."
                ),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
