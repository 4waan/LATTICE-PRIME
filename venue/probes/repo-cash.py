#!/usr/bin/env python3
"""Independent cash and coverage oracle for RepoVault.

Does not import, call, or copy RepoMath.sol. Integer arithmetic only:
purchase price is floor(mark * (10000 - haircut) / 10000); interest is
ceil(principal * rate * elapsed / (10000 * 365 days)); maintenance adds
the ceiling of the fractional margin to accrued exposure.

Vectors consumed by venue/test/RepoCash.t.sol.
"""
from __future__ import annotations

BPS = 10_000
YEAR = 365 * 24 * 60 * 60


def purchase(mark: int, haircut_bps: int) -> int:
    if haircut_bps >= BPS:
        raise ValueError("haircut too large")
    return mark * (BPS - haircut_bps) // BPS


def accrued(principal: int, rate_bps: int, opened: int, at: int) -> int:
    if at < opened:
        raise ValueError("term not started")
    elapsed = at - opened
    num = principal * rate_bps * elapsed
    den = BPS * YEAR
    return (num + den - 1) // den


def repurchase(principal: int, rate_bps: int, opened: int, at: int) -> int:
    return principal + accrued(principal, rate_bps, opened, at)


def maintenance_required(exposure: int, maintenance_bps: int) -> int:
    margin, remainder = divmod(exposure * maintenance_bps, BPS)
    return exposure + margin + (1 if remainder else 0)


def settlement_penalty(reference: int, rate_hundredths: int, days: int) -> int:
    numerator = reference * rate_hundredths * days
    return (numerator + 1_000_000 - 1) // 1_000_000


def main() -> None:
    lot = 1_000
    mark_per = 1_000
    haircut = 200
    rate = 450
    term = 30 * 24 * 60 * 60
    mark = mark_per * lot
    principal = purchase(mark, haircut)
    repay = repurchase(principal, rate, 0, term)
    print(f"mark={mark}")
    print(f"principal={principal}")
    print(f"repurchase_30d={repay}")
    assert principal == 980_000, principal
    assert repay == 983_625, repay
    coverage_vectors = [
        (1, 1, 2),
        (9_999, 1, 10_000),
        (10_000, 1, 10_001),
        (1_000_001, 200, 1_020_002),
    ]
    for exposure, maintenance, expected in coverage_vectors:
        required = maintenance_required(exposure, maintenance)
        print(f"coverage({exposure},{maintenance})={required}")
        assert required == expected, (exposure, maintenance, required)

    max_uint256 = 2**256 - 1
    assert purchase(max_uint256, 0) == max_uint256
    assert accrued(max_uint256, BPS, 0, YEAR) == max_uint256
    assert maintenance_required(max_uint256 // 2, BPS) == max_uint256 - 1
    assert settlement_penalty(max_uint256, 1_000_000, 1) == max_uint256
    print("uint256_boundary_vectors=4")

    checked = 0
    for exposure in range(1, 2_001):
        for maintenance in range(0, 501):
            required = maintenance_required(exposure, maintenance)
            numerator = exposure * (BPS + maintenance)
            quotient, remainder = divmod(numerator, BPS)
            assert required == quotient + (1 if remainder else 0)
            checked += 1
    print(f"coverage_cases={checked}")
    print("ok")


if __name__ == "__main__":
    main()
