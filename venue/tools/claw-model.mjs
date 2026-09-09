// Exact integer inference for the shipped Claw decision network.
//
// The quantized tensors carry integers at dyadic scale 256 and every feature
// is an integer, so the float32 network is reproduced exactly in integer
// arithmetic: hidden values live at scale 256, logits at scale 65536, and the
// largest possible magnitude stays far inside Number.MAX_SAFE_INTEGER. The tie
// rule is WAIT, the same rule the spec and the ONNX graph carry.
export const CLAW_FEATURE_ORDER = [
    "limitRoomBps",
    "recentMoveOffsetBps",
    "roundProgressBps",
    "freshnessSeconds",
    "bufferCategory",
    "horizonCategory",
];

export function clawDecide(model, features) {
    const weights1 = model.tensors.weights1.integers;
    const bias1 = model.tensors.bias1.integers;
    const weights2 = model.tensors.weights2.integers;
    const bias2 = model.tensors.bias2.integers;
    const scale = model.quantization.scale;
    const hidden = bias1.map((bias, unit) => {
        let sum = bias;
        for (let index = 0; index < features.length; index += 1) {
            sum += features[index] * weights1[index][unit];
        }
        return Math.max(sum, 0);
    });
    const logits = bias2.map((bias, label) => {
        let sum = bias * scale;
        for (let unit = 0; unit < hidden.length; unit += 1) {
            sum += hidden[unit] * weights2[unit][label];
        }
        return sum;
    });
    const denominator = scale * scale;
    return {
        decision: logits[1] > logits[0] ? "EXECUTE" : "WAIT",
        logits: [logits[0] / denominator, logits[1] / denominator],
        margin: (logits[1] - logits[0]) / denominator,
    };
}
