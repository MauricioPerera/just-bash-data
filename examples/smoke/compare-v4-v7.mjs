// Diff v0.4.0 vs v0.7.0 replay of the same Llama 3.2 3B command list.
// Run from this directory: node compare-v4-v7.mjs
import { promises as fsp } from "node:fs";

const v4 = JSON.parse(await fsp.readFile("v4-llama32-3b-out.json", "utf8"));
const v7 = JSON.parse(await fsp.readFile("v7-llama32-3b-out.json", "utf8"));

if (v4.length !== v7.length) {
  console.error(`length mismatch: v4=${v4.length} v7=${v7.length}`);
  process.exit(1);
}

const lines = [];
let v4ok = 0, v7ok = 0, regressed = 0, fixed = 0;

for (let i = 0; i < v4.length; i++) {
  const a = v4[i];
  const b = v7[i];
  const aOk = a.exitCode === 0;
  const bOk = b.exitCode === 0;
  if (aOk) v4ok++;
  if (bOk) v7ok++;
  let tag = "  ";
  if (!aOk && bOk) { tag = "✅"; fixed++; }
  else if (aOk && !bOk) { tag = "❌"; regressed++; }
  else if (!aOk && !bOk) tag = "··";
  else tag = "  ";
  const line = `${tag} [${i + 1}] v4=${a.exitCode} v7=${b.exitCode}  ${a.cmd.slice(0, 90)}${a.cmd.length > 90 ? "…" : ""}`;
  lines.push(line);
  if (a.stderr !== b.stderr || a.exitCode !== b.exitCode) {
    if (a.stderr) lines.push(`     v4 stderr: ${a.stderr.trim()}`);
    if (b.stderr) lines.push(`     v7 stderr: ${b.stderr.trim()}`);
    if (!a.stderr && a.stdout !== b.stdout && b.exitCode === 0) {
      lines.push(`     v4 stdout: ${a.stdout.slice(0, 120)}`);
      lines.push(`     v7 stdout: ${b.stdout.slice(0, 120)}`);
    }
  }
}

console.log(lines.join("\n"));
console.log("");
console.log(`v4 success: ${v4ok}/${v4.length}`);
console.log(`v7 success: ${v7ok}/${v7.length}`);
console.log(`fixed by v7: ${fixed}`);
console.log(`regressed: ${regressed}`);
