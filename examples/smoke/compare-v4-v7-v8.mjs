// Three-way diff: v0.4.0 vs v0.7.0 vs v0.8.0 replay of the same Llama 3.2 3B
// command list. Run from this directory: node compare-v4-v7-v8.mjs
import { promises as fsp } from "node:fs";

const v4 = JSON.parse(await fsp.readFile("v4-llama32-3b-out.json", "utf8"));
const v7 = JSON.parse(await fsp.readFile("v7-llama32-3b-out.json", "utf8"));
const v8 = JSON.parse(await fsp.readFile("v8-llama32-3b-out.json", "utf8"));

if (v4.length !== v7.length || v7.length !== v8.length) {
  console.error("length mismatch");
  process.exit(1);
}

console.log("# | v4 | v7 | v8 | command");
console.log("---|----|----|----|--------");
for (let i = 0; i < v4.length; i++) {
  const cmd = v4[i].cmd.length > 70 ? v4[i].cmd.slice(0, 67) + "..." : v4[i].cmd;
  console.log(
    `${String(i + 1).padStart(2)} | ${v4[i].exitCode}  | ${v7[i].exitCode}  | ${v8[i].exitCode}  | ${cmd}`,
  );
  if (v4[i].exitCode !== v7[i].exitCode || v7[i].exitCode !== v8[i].exitCode) {
    if (v4[i].stderr.trim()) console.log(`     v4 stderr: ${v4[i].stderr.trim()}`);
    if (v7[i].stderr.trim()) console.log(`     v7 stderr: ${v7[i].stderr.trim()}`);
    if (v8[i].stderr.trim()) console.log(`     v8 stderr: ${v8[i].stderr.trim()}`);
  }
}

const ok = (a) => a.filter((r) => r.exitCode === 0).length;
console.log("");
console.log(`v4 exit-0: ${ok(v4)}/${v4.length}`);
console.log(`v7 exit-0: ${ok(v7)}/${v7.length}`);
console.log(`v8 exit-0: ${ok(v8)}/${v8.length}`);
