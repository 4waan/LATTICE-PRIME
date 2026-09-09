"""Independent Python codec for the public-instance context limbs."""

from __future__ import annotations

import re


CONTEXT_LIMBS = 173
BASE = 1 << 16
HEX = re.compile(r"^0x[0-9a-fA-F]+$")


class ContextCodecError(ValueError):
    pass


def _unsigned(value, bits: int, name: str, nonzero: bool = False) -> int:
    if isinstance(value, bool):
        raise ContextCodecError(f"{name} is not an unsigned integer")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value):
        parsed = int(value, 10)
    else:
        raise ContextCodecError(f"{name} is not a canonical unsigned integer")
    if parsed < 0 or parsed >= 1 << bits or (nonzero and parsed == 0):
        raise ContextCodecError(f"{name} does not fit uint{bits}")
    return parsed


def _hex(value, size: int, name: str) -> int:
    if not isinstance(value, str) or not HEX.fullmatch(value) or len(value) != 2 + size * 2:
        raise ContextCodecError(f"{name} is not {size} bytes of prefixed hex")
    return int(value[2:], 16)


def _limbs(value: int, count: int) -> list[int]:
    result = []
    for shift in range((count - 1) * 16, -1, -16):
        result.append((value >> shift) & (BASE - 1))
    if value >= 1 << (16 * count):
        raise ContextCodecError(f"value does not fit {count} limbs")
    return result


def encode_context(context: dict) -> list[int]:
    expected = {
        "protocolDomain",
        "chainId",
        "engine",
        "executionAccount",
        "token",
        "side",
        "price",
        "quantity",
        "recoveryAddress",
        "snapshotId",
        "deploymentHash",
        "modelBundleHash",
        "policyHash",
        "mandateNonce",
        "decisionSequence",
        "publicSlot",
        "expiresAt",
        "features",
    }
    if not isinstance(context, dict) or set(context) != expected:
        raise ContextCodecError("context has an unknown or missing field")
    features = context["features"]
    feature_names = {
        "limitRoomBps",
        "recentMoveOffsetBps",
        "roundProgressBps",
        "freshnessSeconds",
        "bufferCategory",
        "horizonCategory",
    }
    if not isinstance(features, dict) or set(features) != feature_names:
        raise ContextCodecError("features have an unknown or missing field")
    if context["side"] != "BUY":
        raise ContextCodecError("the proof spike permits BUY only")

    output = [
        _unsigned(features["limitRoomBps"], 16, "limitRoomBps"),
        _unsigned(features["recentMoveOffsetBps"], 16, "recentMoveOffsetBps"),
        _unsigned(features["roundProgressBps"], 16, "roundProgressBps"),
        _unsigned(features["freshnessSeconds"], 16, "freshnessSeconds"),
        _unsigned(features["bufferCategory"], 16, "bufferCategory"),
        _unsigned(features["horizonCategory"], 16, "horizonCategory"),
    ]
    limits = [2000, 2000, 10_000, 300, 2, 2]
    if any(value > maximum for value, maximum in zip(output, limits)):
        raise ContextCodecError("a feature is outside its declared domain")

    output.extend(_limbs(_hex(context["protocolDomain"], 32, "protocolDomain"), 16))
    output.extend(_limbs(_unsigned(context["chainId"], 64, "chainId"), 4))
    output.extend(_limbs(_hex(context["engine"], 20, "engine"), 10))
    output.extend(_limbs(_hex(context["executionAccount"], 20, "executionAccount"), 10))
    output.extend(_limbs(_hex(context["token"], 20, "token"), 10))
    output.append(0)
    output.extend(_limbs(_unsigned(context["price"], 128, "price", nonzero=True), 8))
    output.extend(_limbs(_unsigned(context["quantity"], 128, "quantity", nonzero=True), 8))
    output.extend(_limbs(_hex(context["recoveryAddress"], 20, "recoveryAddress"), 10))
    output.extend(_limbs(_hex(context["snapshotId"], 32, "snapshotId"), 16))
    output.extend(_limbs(_hex(context["deploymentHash"], 32, "deploymentHash"), 16))
    output.extend(_limbs(_hex(context["modelBundleHash"], 32, "modelBundleHash"), 16))
    output.extend(_limbs(_hex(context["policyHash"], 32, "policyHash"), 16))
    output.extend(_limbs(_hex(context["mandateNonce"], 32, "mandateNonce"), 16))
    output.extend(_limbs(_unsigned(context["decisionSequence"], 32, "decisionSequence"), 2))
    output.extend(_limbs(_unsigned(context["publicSlot"], 64, "publicSlot"), 4))
    output.extend(_limbs(_unsigned(context["expiresAt"], 64, "expiresAt"), 4))
    if len(output) != CONTEXT_LIMBS:
        raise ContextCodecError(f"encoded {len(output)} limbs, expected {CONTEXT_LIMBS}")
    return output
