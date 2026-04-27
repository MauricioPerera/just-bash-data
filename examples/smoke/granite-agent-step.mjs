// Stateless executor for the Granite agent loop.
// Reads a JSON array of bash command strings from argv[2] (path to file).
// Runs each verbatim against just-bash-data (state persisted on real disk).
// Outputs a JSON array of {cmd, stdout, stderr, exitCode, elapsed_ms}.

import { Bash } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.AGENT_DATA_DIR
  ? nodePath.resolve(process.env.AGENT_DATA_DIR)
  : nodePath.resolve(SCRIPT_DIR, "agent-data");

// Minimal disk-backed IFileSystem (only methods the plugin actually uses).
class DiskFs {
  async readFile(p, opts) {
    const enc = typeof opts === "string" ? opts : opts?.encoding ?? "utf8";
    return fsp.readFile(p, enc);
  }
  async readFileBuffer(p) {
    return new Uint8Array(await fsp.readFile(p));
  }
  async writeFile(p, content, opts) {
    await fsp.mkdir(nodePath.dirname(p), { recursive: true });
    if (content instanceof Uint8Array) return fsp.writeFile(p, content);
    const enc = typeof opts === "string" ? opts : opts?.encoding ?? "utf8";
    return fsp.writeFile(p, content, enc);
  }
  async exists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
  }
  async stat(p) {
    const s = await fsp.stat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: false,
      mode: s.mode,
      size: s.size,
      mtime: s.mtime,
    };
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

const cmdsFile = process.argv[2];
if (!cmdsFile) {
  console.error("usage: granite-agent-step.mjs <commands.json>");
  process.exit(2);
}

const cmds = JSON.parse(await fsp.readFile(cmdsFile, "utf8"));
const fs = new DiskFs();
const bash = new Bash({
  fs,
  cwd: STATE_DIR,
  customCommands: createDataPlugin({ rootDir: STATE_DIR }),
});

const results = [];
for (const cmd of cmds) {
  const t0 = Date.now();
  let out;
  try {
    out = await bash.exec(cmd);
  } catch (e) {
    out = { stdout: "", stderr: String(e?.message ?? e), exitCode: 1 };
  }
  results.push({
    cmd,
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode,
    elapsed_ms: Date.now() - t0,
  });
}

process.stdout.write(JSON.stringify(results));
