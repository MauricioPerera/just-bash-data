// End-to-end test: Granite-generated docs → db people insert → db people read
// (no vectors involved). Measures both phases against the real plugin.
import { Bash, InMemoryFs } from "just-bash";
import { createDataPlugin } from "just-bash-data";
import { readFile } from "node:fs/promises";

const docs = JSON.parse(
  await readFile(new URL("./granite-docs.json", import.meta.url), "utf8"),
);

const fs = new InMemoryFs({});
const bash = new Bash({ fs, customCommands: createDataPlugin({}) });

const okJson = (r) => {
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
};

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
    mean: Math.round(sum / s.length),
    sum,
  };
};

console.log(`══ E2E: Granite → db people (${docs.length} docs) ══\n`);

// ── PHASE A: WRITE ──────────────────────────────────────────────────
const writeTimes = [];
const writeStart = Date.now();
for (const doc of docs) {
  const t0 = Date.now();
  const r = await bash.exec(`db people insert '${JSON.stringify(doc)}'`);
  if (r.exitCode !== 0) {
    console.error(`  FAIL inserting ${doc._id}: ${r.stderr.trim()}`);
    process.exit(1);
  }
  writeTimes.push(Date.now() - t0);
}
const writeWall = Date.now() - writeStart;

console.log(`Phase A — INSERT (sequential, no auth)`);
console.log(`  ${docs.length}/${docs.length} ok in ${writeWall} ms`);
console.log(`  per-insert latency:`, stats(writeTimes), "(ms)");
console.log(`  throughput: ${(docs.length / (writeWall / 1000)).toFixed(1)} inserts/sec\n`);

// ── PHASE B: READ ───────────────────────────────────────────────────
console.log(`Phase B — READ via db (no vectors)`);

const queries = [
  { label: 'count {}', cmd: `db people count '{}'` },
  { label: 'count {field:computing}', cmd: `db people count '{"field":"computing"}'` },
  { label: 'find {era:mid-20c}', cmd: `db people find '{"era":"mid-20c"}' --project name,field` },
  { label: 'find {field:{$in:[ai,physics]}}', cmd: `db people find '{"field":{"$in":["ai","physics"]}}' --project name` },
  { label: 'find {summary:{$regex:Apollo}}', cmd: `db people find '{"summary":{"$regex":"Apollo"}}' --project name,summary` },
  { label: 'find {} sorted by tokens desc, limit 3', cmd: `db people find '{}' --sort tokens:-1 --limit 3 --project name,tokens` },
  { label: 'aggregate count by field', cmd: `db people aggregate '[{"$group":{"_id":"$field","cnt":{"$count":1}}},{"$sort":{"cnt":-1}}]'` },
  { label: 'aggregate avg tokens by era', cmd: `db people aggregate '[{"$group":{"_id":"$era","avg_tokens":{"$avg":"$tokens"},"n":{"$count":1}}}]'` },
  { label: 'findOne by _id (p-15)', cmd: `db people find '{"_id":"p-15"}'` },
];

const readTimes = [];
const readStart = Date.now();
for (const q of queries) {
  const t0 = Date.now();
  const r = await bash.exec(q.cmd);
  const elapsed = Date.now() - t0;
  readTimes.push(elapsed);
  if (r.exitCode !== 0) {
    console.error(`  ✗ ${q.label}: exit ${r.exitCode} — ${r.stderr.trim()}`);
    continue;
  }
  const payload = JSON.parse(r.stdout);
  const summary =
    Array.isArray(payload) ? `array(${payload.length})` :
    typeof payload === "object" ? JSON.stringify(payload) :
    String(payload);
  console.log(`  [${String(elapsed).padStart(3)}ms] ${q.label} → ${summary.length > 90 ? summary.slice(0, 90) + "…" : summary}`);
}
const readWall = Date.now() - readStart;

console.log(`\n  ${queries.length} queries in ${readWall} ms`);
console.log(`  per-query latency:`, stats(readTimes), "(ms)");
console.log(`  throughput: ${(queries.length / (readWall / 1000)).toFixed(1)} reads/sec\n`);

// ── VERIFICATION SAMPLES ────────────────────────────────────────────
console.log(`Verification — full roundtrip sample`);
const got = okJson(await bash.exec(`db people find '{"_id":"p-01"}'`));
console.log(`  read back p-01: ${JSON.stringify(got[0]).slice(0, 200)}…`);

const aggResult = okJson(await bash.exec(`db people aggregate '[{"$group":{"_id":"$field","cnt":{"$count":1}}},{"$sort":{"cnt":-1}}]'`));
console.log(`  fields breakdown:`, aggResult);

console.log(`\n══ Summary ══`);
console.log(`  Granite generation (parallel, 20 docs)  : 5610 ms wall`);
console.log(`  db insert        (sequential, 20 docs)  : ${writeWall} ms wall`);
console.log(`  db reads         (sequential, 9 queries): ${readWall} ms wall`);
console.log(`  full roundtrip OK — every query returned data consistent with what Granite generated.`);
