const fs = require("fs");
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const arr = (a) => "[" + a.join(",") + "]";
function load(n) {
  const p = JSON.parse(fs.readFileSync(`proof/${n}_proof.json`));
  const s = JSON.parse(fs.readFileSync(`proof/${n}_public.json`));
  return {
    A: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
    B: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])],
        [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
    C: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
    S: s.map(BigInt),
  };
}
const t = load("trivial"), f = load("five");
const B = (b) => arr([arr(b[0]), arr(b[1])]);
const out = [];
const P = (k...v) => out.push(`${k}=( '${v.join("' '")}' )`);
// name -> the four argument groups, as one quoted string list
P("T_VALID",    arr(t.A), B(t.B), arr(t.C), arr(t.S));
P("T_NEGA",     arr([t.A[0], Q - t.A[1]]), B(t.B), arr(t.C), arr(t.S));
P("T_WRONGSIG", arr(t.A), B(t.B), arr(t.C), arr([t.S[0] + 1n]));
P("T_OFFCURVE", arr([1n, 1n]), B(t.B), arr(t.C), arr(t.S));
P("T_SIGATR",   arr(t.A), B(t.B), arr(t.C), arr([R]));
P("F_VALID",    arr(f.A), B(f.B), arr(f.C), arr(f.S));
fs.writeFileSync("args.env", out.join("\n") + "\n");
console.log(out.map(l => l.slice(0, 60) + " ...").join("\n"));
