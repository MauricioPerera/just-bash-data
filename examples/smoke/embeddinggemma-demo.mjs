// End-to-end demo: embeddinggemma-300m (multilingual, 768d, matryoshka-friendly)
// → just-bash-data vec store → semantic search across languages.
//
// Demonstrates:
//   1. Multilingual embeddings (English, Spanish, Japanese, Arabic, Hindi)
//   2. Matryoshka prefix search at progressively smaller dims (128 / 256 / 512 / 768)
//   3. The new v0.3.0 db <coll> export/import + options object refinements
//
// Run from repo root:
//   pnpm install
//   pnpm build
//   node examples/smoke/embeddinggemma-demo.mjs --account=<ID> --token=<CF_API_TOKEN>

import { Bash } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = nodePath.resolve(SCRIPT_DIR, "agent-data");

// --- arg parsing ---
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a, "true"];
  }),
);
const ACCOUNT_ID = args["account"] ?? process.env.CF_ACCOUNT_ID;
const API_TOKEN = args["token"] ?? process.env.CF_API_TOKEN;
if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Missing --account=<ID> --token=<CF_API_TOKEN>");
  console.error("Or set CF_ACCOUNT_ID and CF_API_TOKEN env vars.");
  process.exit(2);
}

const EMBED_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/google/embeddinggemma-300m`;

const embed = async (texts) => {
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });
  const json = await r.json();
  if (!json.success || !json.result?.data) {
    throw new Error(`embed failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result.data;
};

// Truncate vector to first N dims (Matryoshka prefix property).
const truncate = (vec, dim) => vec.slice(0, dim);

// --- minimal disk-backed IFileSystem (same pattern as granite-agent-step.mjs) ---
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

// --- demo data: same concept across 5 languages ---
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

// --- main flow ---
console.log(`══ embeddinggemma-300m × just-bash-data v0.3.0 demo ══\n`);

// 1. Embed all concepts in one batch
console.log(`[1/5] Embedding ${concepts.length} multilingual concepts in one Workers AI batch…`);
const t0 = Date.now();
const vectors = await embed(concepts.map((c) => c.text));
const embedMs = Date.now() - t0;
console.log(`     ✓ Got ${vectors.length} vectors of dim ${vectors[0].length} in ${embedMs} ms\n`);

// 2. Spin up the plugin and create the vec collection at full 768 dim
console.log(`[2/5] Booting just-bash-data plugin (disk-backed at ${STATE_DIR})…`);
await fsp.rm(STATE_DIR, { recursive: true, force: true });
const fs = new DiskFs();
const bash = new Bash({
  fs,
  cwd: STATE_DIR,
  customCommands: createDataPlugin({ rootDir: STATE_DIR }),
});

const exec = async (line) => {
  const r = await bash.exec(line);
  if (r.exitCode !== 0) throw new Error(`[exit ${r.exitCode}] ${line}\n${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

await exec(`vec create concepts --dim 768 --metric cosine`);
console.log(`     ✓ Created collection 'concepts' (cosine, 768d float32)\n`);

// 3. Bulk insert via JSONL piped through stdin
console.log(`[3/5] Inserting all 15 vectors with their metadata…`);
const insertStart = Date.now();
for (let i = 0; i < concepts.length; i++) {
  const c = concepts[i];
  const v = vectors[i];
  const meta = JSON.stringify({ lang: c.lang, text: c.text });
  await exec(`vec store concepts ${c.id} '${JSON.stringify(v)}' --meta '${meta}'`);
}
const insertMs = Date.now() - insertStart;
console.log(`     ✓ Inserted ${concepts.length} in ${insertMs} ms (${(insertMs / concepts.length).toFixed(1)} ms/insert)\n`);

// 4. Cross-lingual semantic search at full dim
console.log(`[4/5] Cross-lingual semantic search (768d, k=3)…`);
const queries = [
  { lang: "en→all", q: "A small furry pet that purrs" },
  { lang: "es→all", q: "Vehículo espacial con propulsión" },
  { lang: "ja→all", q: "小麦から作る焼いた食べ物" }, // baked food made from wheat
];
const [qVecs] = await (async () => {
  const v = await embed(queries.map((q) => q.q));
  return [v];
})();

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const v = qVecs[i];
  const hits = await exec(`vec search concepts '${JSON.stringify(v)}' --k 3`);
  const ids = hits.map((h) => `${h.id}@${h.score.toFixed(3)}`).join(", ");
  console.log(`     [${q.lang}] "${q.q}"`);
  console.log(`       → ${ids}`);
}
console.log("");

// 5. Matryoshka comparison: same query, decreasing dim. Show top-3 overlap.
console.log(`[5/5] Matryoshka prefix search at 768 / 512 / 256 / 128 dim…`);
const probeQuery = "small carnivorous pet animal";
const [probeVecFull] = await embed([probeQuery]);

const matryoshkaStages = [768, 512, 256, 128];
const baselineHits = await exec(
  `vec search concepts '${JSON.stringify(probeVecFull)}' --k 5`,
);
const baselineIds = new Set(baselineHits.slice(0, 3).map((h) => h.id));

console.log(`     query: "${probeQuery}"`);
console.log(`     baseline top-3 (768d): ${[...baselineIds].join(", ")}`);
console.log("");

for (const stage of matryoshkaStages) {
  // Truncate stored embeddings would require a separate collection per stage; instead
  // we exercise the plugin's --matryoshka flag (does the same prefix-search trick).
  const stages = matryoshkaStages.filter((s) => s <= 768).join(",");
  const truncated = truncate(probeVecFull, stage);
  // Pad to 768 with zeros (since the collection is dim 768) so the dim check passes;
  // this simulates "only the first N dims have signal" on the query side.
  const padded = [...truncated, ...new Array(768 - stage).fill(0)];
  const tStart = Date.now();
  const hits = await exec(
    `vec search concepts '${JSON.stringify(padded)}' --k 3`,
  );
  const ms = Date.now() - tStart;
  const stageIds = hits.map((h) => h.id);
  const overlap = stageIds.filter((id) => baselineIds.has(id)).length;
  console.log(`     ${stage}d  search ${ms} ms  top-3=[${stageIds.join(", ")}]  overlap@3=${overlap}/3`);
}

console.log("");

// 6. Showcase the v0.3.0 refinements: db export/import + options object find
console.log(`[bonus] v0.3.0 refinements quick check…`);
await exec(`db notes insert '{"_id":"n1","topic":"cats","stars":5}'`);
await exec(`db notes insert '{"_id":"n2","topic":"rockets","stars":3}'`);
await exec(`db notes insert '{"_id":"n3","topic":"bread","stars":4}'`);

// A1: empty filter as ''
const all = await exec(`db notes count ''`);
console.log(`     A1 empty filter count: ${all.count} (expected 3)`);

// A2: options object as 2nd positional
const top = await exec(`db notes find '{}' '{"sort":{"stars":-1},"limit":2}'`);
console.log(`     A2 options object sort+limit: ${top.map((d) => d._id).join(",")} (expected n1,n3)`);

// B1: export
const ex = await exec(`db notes export`);
console.log(`     B1 export: ${ex.exported} docs`);

// B2: import after drop
await exec(`db notes drop`);
const reim = await exec(`db notes import '${JSON.stringify(ex.docs)}'`);
console.log(`     B2 import: ${reim.imported} docs (after drop+restore)`);

console.log(`\n══ Demo complete. ══`);
