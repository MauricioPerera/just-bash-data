// v0.8.1 benchmark replay across all 8 models from the original transcript set.
// Concatenates per-turn cmd files where needed, replays each model's full
// trace against v0.8.1 in a fresh disk-backed Bash, writes one
// v8-<model>-out.json per model + a v8-summary.json + console table.
//
// Run from this directory: node v8-benchmark.mjs
import { Bash } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = nodePath.dirname(fileURLToPath(import.meta.url));

class DiskFs {
  async readFile(p, opts) {
    const enc = typeof opts === "string" ? opts : opts?.encoding ?? "utf8";
    return fsp.readFile(p, enc);
  }
  async readFileBuffer(p) { return new Uint8Array(await fsp.readFile(p)); }
  async writeFile(p, content, opts) {
    await fsp.mkdir(nodePath.dirname(p), { recursive: true });
    if (content instanceof Uint8Array) return fsp.writeFile(p, content);
    const enc = typeof opts === "string" ? opts : opts?.encoding ?? "utf8";
    return fsp.writeFile(p, content, enc);
  }
  async exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
  async stat(p) {
    const s = await fsp.stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: false, mode: s.mode, size: s.size, mtime: s.mtime };
  }
  async mkdir(p, opts) { await fsp.mkdir(p, { recursive: opts?.recursive ?? false }); }
  async readdir(p) { return fsp.readdir(p); }
  async rm(p, opts) {
    try { await fsp.rm(p, { force: opts?.force ?? false, recursive: opts?.recursive ?? false }); }
    catch (e) { if (!opts?.force) throw e; }
  }
  async mv(src, dest) { return fsp.rename(src, dest); }
  resolvePath(base, p) { return nodePath.resolve(base, p); }
  async appendFile() { throw new Error("not impl"); }
  async cp() { throw new Error("not impl"); }
  async chmod() {}
  async symlink() { throw new Error("not impl"); }
  async link() { throw new Error("not impl"); }
  async readlink() { throw new Error("not impl"); }
  async lstat(p) { return this.stat(p); }
  async realpath(p) { return p; }
  async utimes() {}
  getAllPaths() { return []; }
}

// 8 models. For each: which file(s) provide the command trace, and which
// v0.4.0 reference output (if any) to diff against.
const MODELS = [
  { id: "granite",       label: "Granite 4.0",       turns: ["turn1-cmds.json", "turn2-cmds.json", "turn3-cmds.json"], v4ref: null },
  { id: "llama32-3b",    label: "Llama 3.2 3B",      turns: ["v4-llama32-3b-cmds.json"], v4ref: "v4-llama32-3b-out.json" },
  { id: "awq",           label: "Llama 3.1 8B AWQ",  turns: ["v4-awq-cmds.json"],        v4ref: "v4-awq-out.json" },
  { id: "fp",            label: "Llama 3.1 8B FP",   turns: ["v4-fp-cmds.json"],         v4ref: "v4-fp-out.json" },
  { id: "llama11bv",     label: "Llama 3.2 11B-V",   turns: ["llama11bv-turn1-cmds.json","llama11bv-turn2-cmds.json","llama11bv-turn3-cmds.json","llama11bv-turn4-cmds.json","llama11bv-turn5-cmds.json"], v4ref: null },
  { id: "gptoss",        label: "GPT-OSS-20B",       turns: ["gptoss-turn1-cmds.json","gptoss-turn2-cmds.json"], v4ref: null },
  { id: "scout",         label: "Llama 4 Scout",     turns: ["v4-scout-cmds.json"], v4ref: "v4-scout-out.json" },
  { id: "gemma4",        label: "Gemma 4 26B",       turns: ["gemma4-turn1-cmds.json","gemma4-turn2-cmds.json","gemma4-turn3-cmds.json","gemma4-turn4-cmds.json"], v4ref: null },
];

async function loadCmds(turns) {
  const all = [];
  for (const t of turns) {
    const arr = JSON.parse(await fsp.readFile(nodePath.join(SCRIPT_DIR, t), "utf8"));
    if (!Array.isArray(arr)) throw new Error(`${t} not array`);
    all.push(...arr);
  }
  return all;
}

async function runOne(model) {
  const stateDir = nodePath.join(SCRIPT_DIR, `v8-${model.id}-state`);
  await fsp.rm(stateDir, { recursive: true, force: true });
  await fsp.mkdir(stateDir, { recursive: true });

  const cmds = await loadCmds(model.turns);
  const fs = new DiskFs();
  const bash = new Bash({ fs, cwd: stateDir, customCommands: createDataPlugin({ rootDir: stateDir }) });

  const results = [];
  for (const cmd of cmds) {
    const t0 = Date.now();
    let out;
    try { out = await bash.exec(cmd); }
    catch (e) { out = { stdout: "", stderr: String(e?.message ?? e), exitCode: 1 }; }
    results.push({ cmd, stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, elapsed_ms: Date.now() - t0 });
  }

  await fsp.writeFile(
    nodePath.join(SCRIPT_DIR, `v8-${model.id}-out.json`),
    JSON.stringify(results),
  );
  await fsp.rm(stateDir, { recursive: true, force: true });
  return results;
}

function summarize(model, v8Results, v4Results) {
  const v8ok = v8Results.filter((r) => r.exitCode === 0).length;
  const v8total = v8Results.length;

  let v4ok = null, v4total = null;
  let fixed = 0, regressed = 0, silent_to_loud = 0, deltas = [];
  if (v4Results) {
    v4ok = v4Results.filter((r) => r.exitCode === 0).length;
    v4total = v4Results.length;
    for (let i = 0; i < Math.min(v4Results.length, v8Results.length); i++) {
      const a = v4Results[i], b = v8Results[i];
      if (a.exitCode === b.exitCode) continue;
      const aOk = a.exitCode === 0, bOk = b.exitCode === 0;
      // "silent_to_loud" flips: v4 was exit 0 (often silently wrong), v8 is now exit 5 (validation).
      // This is the v0.8.0/v0.8.1 win mode — agent gets a retry signal.
      if (aOk && b.exitCode === 5) silent_to_loud++;
      if (!aOk && bOk) fixed++;
      else if (aOk && !bOk) regressed++;
      deltas.push({ idx: i, v4: a.exitCode, v8: b.exitCode, cmd: a.cmd, v4err: a.stderr.trim(), v8err: b.stderr.trim() });
    }
  }
  return { model: model.label, v8ok, v8total, v4ok, v4total, fixed, regressed, silent_to_loud, deltas };
}

const allSummaries = [];
for (const model of MODELS) {
  process.stdout.write(`replaying ${model.label}... `);
  const v8results = await runOne(model);
  let v4results = null;
  if (model.v4ref) {
    try { v4results = JSON.parse(await fsp.readFile(nodePath.join(SCRIPT_DIR, model.v4ref), "utf8")); }
    catch { /* missing — comparison just unavailable */ }
  }
  const s = summarize(model, v8results, v4results);
  allSummaries.push(s);
  console.log(`v8: ${s.v8ok}/${s.v8total} exit-0${s.v4total !== null ? `  (v4 was ${s.v4ok}/${s.v4total})` : ""}`);
}

console.log("");
console.log("model                  | v4 exit-0 | v8 exit-0 | silent→loud | fixed | regress");
console.log("-----------------------|-----------|-----------|-------------|-------|--------");
for (const s of allSummaries) {
  const v4str = s.v4total !== null ? `${s.v4ok}/${s.v4total}`.padStart(9) : "n/a".padStart(9);
  const v8str = `${s.v8ok}/${s.v8total}`.padStart(9);
  const slstr = s.v4total !== null ? String(s.silent_to_loud).padStart(11) : "n/a".padStart(11);
  const fstr  = s.v4total !== null ? String(s.fixed).padStart(5) : "n/a".padStart(5);
  const rstr  = s.v4total !== null ? String(s.regressed).padStart(7) : "n/a".padStart(7);
  console.log(`${s.model.padEnd(22)} | ${v4str} | ${v8str} | ${slstr} | ${fstr} | ${rstr}`);
}

await fsp.writeFile(
  nodePath.join(SCRIPT_DIR, "v8-summary.json"),
  JSON.stringify(allSummaries, null, 2),
);
console.log("");
console.log("wrote v8-summary.json + v8-<model>-out.json for each model");
