// Sister of embeddinggemma-demo.mjs that uses openai-workers-ai-bridge
// (https://github.com/MauricioPerera/openai-workers-ai-bridge) instead of
// calling the Workers AI REST API directly.
//
// What this demonstrates over the direct-REST demo:
//   * Server-side Matryoshka truncation — passing `dimensions: 256` returns
//     a 256-dim vector that's already L2-renormalised, so we don't truncate
//     and pad on the client side. Smaller wire payloads, smaller storage.
//   * One backend URL across every OpenAI-compatible client (this script,
//     LangChain, n8n, LibreChat, the OpenAI SDK), no per-tool key plumbing.
//   * Idempotent embedding cache: the bridge stashes vectors at the edge,
//     so re-runs of the same script cost 0 neurons after the first.
//
// Run from repo root:
//   pnpm install
//   pnpm build
//   node examples/smoke/openai-bridge-demo.mjs \
//     --bridge=https://openai-workers-ai-bridge.<sub>.workers.dev/v1 \
//     --key=sk-cfwai-...

import OpenAI from "openai";
import { Bash } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = nodePath.resolve(SCRIPT_DIR, "agent-data-bridge");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a, "true"];
  }),
);
const BRIDGE_URL = args["bridge"] ?? process.env.BRIDGE_URL;
const API_KEY = args["key"] ?? process.env.BRIDGE_API_KEY;
if (!BRIDGE_URL || !API_KEY) {
  console.error("Missing --bridge=<URL> --key=<API_KEY>");
  console.error("Or set BRIDGE_URL and BRIDGE_API_KEY env vars.");
  process.exit(2);
}
const DIM = Number(args["dim"] ?? 256);

const client = new OpenAI({ apiKey: API_KEY, baseURL: BRIDGE_URL });

async function embed(texts) {
  const res = await client.embeddings.create({
    model: "embeddinggemma",
    input: texts,
    dimensions: DIM,
  });
  return res.data.map((d) => d.embedding);
}

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
  async appendFile() { throw new Error("ni"); }
  async cp() { throw new Error("ni"); }
  async chmod() {}
  async symlink() { throw new Error("ni"); }
  async link() { throw new Error("ni"); }
  async readlink() { throw new Error("ni"); }
  async lstat(p) { return this.stat(p); }
  async realpath(p) { return p; }
  async utimes() {}
  getAllPaths() { return []; }
}

const concepts = [
  { id: "en-cat",     lang: "en", text: "A cat is a small carnivorous mammal kept as a pet." },
  { id: "es-cat",     lang: "es", text: "Un gato es un pequeño mamífero carnívoro mantenido como mascota." },
  { id: "ja-cat",     lang: "ja", text: "猫は飼われている小さな肉食哺乳類です。" },
  { id: "ar-cat",     lang: "ar", text: "القطة حيوان ثديي مفترس صغير يربى كحيوان أليف." },
  { id: "hi-cat",     lang: "hi", text: "बिल्ली एक छोटा मांसाहारी स्तनधारी है जो पालतू रखा जाता है।" },
  { id: "en-rocket",  lang: "en", text: "A rocket is a vehicle that uses thrust to travel into space." },
  { id: "es-rocket",  lang: "es", text: "Un cohete es un vehículo que usa empuje para viajar al espacio." },
  { id: "ja-rocket",  lang: "ja", text: "ロケットは推進力を使って宇宙へ飛ぶ乗り物です。" },
  { id: "ar-rocket",  lang: "ar", text: "الصاروخ مركبة تستخدم الدفع للسفر إلى الفضاء." },
  { id: "hi-rocket",  lang: "hi", text: "रॉकेट एक वाहन है जो अंतरिक्ष में यात्रा करने के लिए जोर का उपयोग करता है।" },
  { id: "en-bread",   lang: "en", text: "Bread is a staple food made from flour and water, then baked." },
  { id: "es-bread",   lang: "es", text: "El pan es un alimento básico hecho de harina y agua, luego horneado." },
  { id: "ja-bread",   lang: "ja", text: "パンは小麦粉と水から作られて焼かれる主食です。" },
  { id: "ar-bread",   lang: "ar", text: "الخبز غذاء أساسي يُصنع من الدقيق والماء ثم يُخبز." },
  { id: "hi-bread",   lang: "hi", text: "रोटी आटे और पानी से बनी और बेक की गई एक मुख्य खाद्य है।" },
];

console.log(`══ openai-workers-ai-bridge × just-bash-data demo (dim=${DIM}) ══\n`);

console.log(`[1/4] Embedding ${concepts.length} concepts via the bridge (Matryoshka dim=${DIM})…`);
const t0 = Date.now();
const vectors = await embed(concepts.map((c) => c.text));
const embedMs = Date.now() - t0;
console.log(`     ✓ Got ${vectors.length} vectors of dim ${vectors[0].length} in ${embedMs} ms`);
console.log(`     (re-running this script costs 0 neurons — bridge edge-caches identical inputs)\n`);

console.log(`[2/4] Booting just-bash-data plugin (disk-backed at ${STATE_DIR})…`);
await fsp.rm(STATE_DIR, { recursive: true, force: true });
const fs = new DiskFs();
const bash = new Bash({ fs, cwd: STATE_DIR, customCommands: createDataPlugin({ rootDir: STATE_DIR }) });
const exec = async (line) => {
  const r = await bash.exec(line);
  if (r.exitCode !== 0) throw new Error(`[exit ${r.exitCode}] ${line}\n${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
await exec(`vec create concepts --dim ${DIM} --metric cosine`);
console.log(`     ✓ Collection 'concepts' (cosine, ${DIM}d float32)\n`);

console.log(`[3/4] Inserting all ${concepts.length} vectors…`);
const insertStart = Date.now();
for (let i = 0; i < concepts.length; i++) {
  const c = concepts[i];
  const meta = JSON.stringify({ lang: c.lang, text: c.text });
  await exec(`vec store concepts ${c.id} '${JSON.stringify(vectors[i])}' --meta '${meta}'`);
}
const insertMs = Date.now() - insertStart;
console.log(`     ✓ ${concepts.length} inserts in ${insertMs} ms (${(insertMs / concepts.length).toFixed(1)} ms/insert)\n`);

console.log(`[4/4] Cross-lingual search (k=3)…`);
const queries = [
  { lang: "en→all", q: "A small furry pet that purrs" },
  { lang: "es→all", q: "Vehículo espacial con propulsión" },
  { lang: "ja→all", q: "小麦から作る焼いた食べ物" },
];
const qVecs = await embed(queries.map((q) => q.q));
for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const v = qVecs[i];
  const hits = await exec(`vec search concepts '${JSON.stringify(v)}' --k 3`);
  const ids = hits.map((h) => `${h.id}@${h.score.toFixed(3)}`).join(", ");
  console.log(`     [${q.lang}] "${q.q}"`);
  console.log(`       → ${ids}`);
}
console.log("");

console.log(`── done. The bridge handed back ${DIM}-dim L2-normalised vectors,`);
console.log(`   so just-bash-data's vec store consumed them as-is — no client-side`);
console.log(`   truncation, no padding, no extra renorm.`);
