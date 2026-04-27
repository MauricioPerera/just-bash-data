// Full E2E smoke test against the published tarball.
// Exercises every subcommand, every operator, every error class, and
// cross-instance persistence + encryption.
import { Bash, InMemoryFs } from "just-bash";
import { createDataPlugin } from "just-bash-data";

let passed = 0;
let failed = 0;
const failures = [];

const ok = (cond, msg) => {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
};

const section = (title) => console.log(`\n── ${title} ────────`);

const buildBash = (opts = {}, fs = new InMemoryFs({})) =>
  ({ bash: new Bash({ fs, customCommands: createDataPlugin(opts) }), fs });

const exec = async (bash, line) => bash.exec(line);
const okExit = (r, code, label) => {
  ok(r.exitCode === code, `${label}: exit=${code} (got ${r.exitCode}, stderr=${r.stderr.trim()})`);
  return r;
};
const okOut = (r, label) => {
  ok(r.exitCode === 0, `${label}: exit 0 (got ${r.exitCode}, stderr=${r.stderr.trim()})`);
  if (r.exitCode !== 0) return null;
  try { return JSON.parse(r.stdout); }
  catch { ok(false, `${label}: stdout JSON parseable (got: ${r.stdout.slice(0, 80)})`); return null; }
};

const main = async () => {
  // ──────────────────────────────────────────────────────────────────
  section("db: insert / find / count round-trip");
  {
    const { bash } = buildBash();
    okOut(await exec(bash, `db users insert '{"name":"Alice","age":30,"tag":"vip"}'`), "insert Alice");
    okOut(await exec(bash, `db users insert '{"name":"Bob","age":25,"tag":"std"}'`), "insert Bob");
    okOut(await exec(bash, `db users insert '{"name":"Carol","age":40,"tag":"vip","addr":{"city":"BA"}}'`), "insert Carol");

    const all = okOut(await exec(bash, `db users find '{}'`), "find {}");
    ok(Array.isArray(all) && all.length === 3, "find {} → 3 docs");

    const cnt = okOut(await exec(bash, `db users count '{}'`), "count {}");
    ok(cnt.count === 3, `count = 3 (got ${cnt.count})`);
  }

  // ──────────────────────────────────────────────────────────────────
  section("db find: every Mongo-style operator");
  {
    const { bash } = buildBash();
    for (let i = 1; i <= 10; i++) {
      await exec(bash, `db x insert '{"n":${i},"tag":"${i % 2 === 0 ? "even" : "odd"}","arr":[${i},${i + 1}]}'`);
    }

    let r = okOut(await exec(bash, `db x find '{"n":{"$eq":5}}'`), "$eq");
    ok(r.length === 1 && r[0].n === 5, "$eq:5 found 1");

    r = okOut(await exec(bash, `db x find '{"n":{"$ne":5}}'`), "$ne");
    ok(r.length === 9, "$ne:5 → 9");

    r = okOut(await exec(bash, `db x find '{"n":{"$gt":7}}'`), "$gt");
    ok(r.length === 3, "$gt:7 → 3");

    r = okOut(await exec(bash, `db x find '{"n":{"$gte":7}}'`), "$gte");
    ok(r.length === 4, "$gte:7 → 4");

    r = okOut(await exec(bash, `db x find '{"n":{"$lt":3}}'`), "$lt");
    ok(r.length === 2, "$lt:3 → 2");

    r = okOut(await exec(bash, `db x find '{"n":{"$lte":3}}'`), "$lte");
    ok(r.length === 3, "$lte:3 → 3");

    r = okOut(await exec(bash, `db x find '{"tag":{"$in":["odd"]}}'`), "$in");
    ok(r.length === 5, "$in:[odd] → 5");

    r = okOut(await exec(bash, `db x find '{"tag":{"$nin":["odd"]}}'`), "$nin");
    ok(r.length === 5, "$nin:[odd] → 5");

    r = okOut(await exec(bash, `db x find '{"tag":{"$regex":"^ev"}}'`), "$regex");
    ok(r.length === 5, "$regex:^ev → 5");

    r = okOut(await exec(bash, `db x find '{"tag":{"$exists":true}}'`), "$exists");
    ok(r.length === 10, "$exists:true → 10");

    r = okOut(await exec(bash, `db x find '{"$and":[{"n":{"$gt":3}},{"tag":"even"}]}'`), "$and");
    ok(r.length === 4, "$and → 4");

    r = okOut(await exec(bash, `db x find '{"$or":[{"n":1},{"n":10}]}'`), "$or");
    ok(r.length === 2, "$or → 2");

    // sort / limit / skip / project
    r = okOut(await exec(bash, `db x find '{}' --sort n:-1 --limit 3`), "sort+limit");
    ok(r.length === 3 && r[0].n === 10 && r[2].n === 8, "sort desc + limit");

    r = okOut(await exec(bash, `db x find '{}' --sort n:1 --skip 2 --limit 2`), "sort+skip+limit");
    ok(r[0].n === 3 && r[1].n === 4, "sort asc + skip + limit");

    r = okOut(await exec(bash, `db x find '{"n":1}' --project n,tag`), "project");
    ok(r[0].n === 1 && r[0].tag === "odd" && r[0].arr === undefined, "project: only n,tag returned");
  }

  // ──────────────────────────────────────────────────────────────────
  section("db update: $set / $inc / $push / $pull / $unset / $rename");
  {
    const { bash } = buildBash();
    await exec(bash, `db x insert '{"_id":"u1","n":1,"tags":["a"],"old":1}'`);

    let r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$set":{"n":99}}'`), "update $set");
    ok(r.matched === 1 && r.modified === 1, "update $set: matched=1 modified=1");

    r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$inc":{"n":5}}'`), "update $inc");
    ok(r.modified === 1, "update $inc: 1 modified");
    let docs = okOut(await exec(bash, `db x find '{"_id":"u1"}'`), "find post-$inc");
    ok(docs[0].n === 104, `n=104 after $inc:+5 (got ${docs[0].n})`);

    r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$push":{"tags":"b"}}'`), "update $push");
    docs = okOut(await exec(bash, `db x find '{"_id":"u1"}'`), "find post-$push");
    ok(docs[0].tags.includes("a") && docs[0].tags.includes("b"), "$push appended b");

    r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$pull":{"tags":"a"}}'`), "update $pull");
    docs = okOut(await exec(bash, `db x find '{"_id":"u1"}'`), "find post-$pull");
    ok(!docs[0].tags.includes("a"), "$pull removed a");

    r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$unset":{"old":""}}'`), "update $unset");
    docs = okOut(await exec(bash, `db x find '{"_id":"u1"}'`), "find post-$unset");
    ok(docs[0].old === undefined, "$unset removed field");

    r = okOut(await exec(bash, `db x update '{"_id":"u1"}' '{"$rename":{"n":"value"}}'`), "update $rename");
    docs = okOut(await exec(bash, `db x find '{"_id":"u1"}'`), "find post-$rename");
    ok(docs[0].value === 104 && docs[0].n === undefined, "$rename: n→value");
  }

  // ──────────────────────────────────────────────────────────────────
  section("db aggregate: $match + $lookup + $group + $sort + $limit + $project + $unwind");
  {
    const { bash } = buildBash();
    await exec(bash, `db users insert '{"_id":"u1","name":"Alice","country":"AR"}'`);
    await exec(bash, `db users insert '{"_id":"u2","name":"Bob","country":"AR"}'`);
    await exec(bash, `db users insert '{"_id":"u3","name":"Carol","country":"US"}'`);
    await exec(bash, `db orders insert '{"userId":"u1","amt":100,"status":"paid"}'`);
    await exec(bash, `db orders insert '{"userId":"u1","amt":50,"status":"paid"}'`);
    await exec(bash, `db orders insert '{"userId":"u2","amt":200,"status":"open"}'`);
    await exec(bash, `db orders insert '{"userId":"u3","amt":300,"status":"paid"}'`);

    // $match + $lookup + $group
    let r = okOut(await exec(bash, `db orders aggregate '[
      {"$match":{"status":"paid"}},
      {"$lookup":{"from":"users","localField":"userId","foreignField":"_id","as":"user","single":true}},
      {"$group":{"_id":"$user.country","total":{"$sum":"$amt"}}}
    ]'`), "aggregate match+lookup+group");
    const ar = r.find(x => x._id === "AR");
    const us = r.find(x => x._id === "US");
    ok(ar && ar.total === 150, `AR total=150 (got ${ar?.total})`);
    ok(us && us.total === 300, `US total=300 (got ${us?.total})`);

    // All accumulators on a flat group
    r = okOut(await exec(bash, `db orders aggregate '[
      {"$group":{"_id":"$status","cnt":{"$count":1},"sum":{"$sum":"$amt"},"avg":{"$avg":"$amt"},"min":{"$min":"$amt"},"max":{"$max":"$amt"}}}
    ]'`), "aggregate all accumulators");
    const paid = r.find(x => x._id === "paid");
    ok(paid && paid.cnt === 3 && paid.sum === 450 && paid.min === 50 && paid.max === 300, "$count/$sum/$min/$max all correct on paid group");

    // $sort + $limit + $project
    r = okOut(await exec(bash, `db orders aggregate '[
      {"$sort":{"amt":-1}},
      {"$limit":2},
      {"$project":{"amt":1,"status":1}}
    ]'`), "aggregate sort+limit+project");
    ok(r.length === 2 && r[0].amt === 300 && r[1].amt === 200, "sort desc + limit 2 produces top-2");

    // $unwind
    await exec(bash, `db items insert '{"name":"box","tags":["a","b","c"]}'`);
    r = okOut(await exec(bash, `db items aggregate '[{"$unwind":"tags"}]'`), "aggregate $unwind");
    ok(r.length === 3 && r.every(d => typeof d.tags === "string"), "$unwind expanded array to 3 docs");
  }

  // ──────────────────────────────────────────────────────────────────
  section("db indexes: hash, sorted, unique, list, drop");
  {
    const { bash } = buildBash();
    await exec(bash, `db x insert '{"a":1,"email":"a@x.com"}'`);
    await exec(bash, `db x insert '{"a":2,"email":"b@x.com"}'`);

    okOut(await exec(bash, `db x index create a`), "create hash index");
    okOut(await exec(bash, `db x index create a_sorted --sorted`), "create sorted index");
    okOut(await exec(bash, `db x index create email --unique`), "create unique index");

    const list = okOut(await exec(bash, `db x index list`), "index list");
    ok(list.length === 3, `index list: 3 entries (got ${list.length})`);

    // unique violation → exit 5
    okExit(await exec(bash, `db x insert '{"email":"a@x.com"}'`), 5, "unique violation");

    okOut(await exec(bash, `db x index drop a`), "drop hash index");
    const list2 = okOut(await exec(bash, `db x index list`), "index list after drop");
    ok(list2.length === 2, "index list: 2 after drop");

    // drop missing index → exit 3
    okExit(await exec(bash, `db x index drop ghost`), 3, "drop missing index → 3");
  }

  // ──────────────────────────────────────────────────────────────────
  section("db auth full flow + RBAC matrix");
  {
    const { bash } = buildBash({ authSecret: "smoke-secret" });

    okOut(await exec(bash, `db auth register admin@x.com pwlong123 --roles=admin`), "register admin");
    okOut(await exec(bash, `db auth register user@x.com pwlong123`), "register user");

    const adminLogin = okOut(await exec(bash, `db auth login admin@x.com pwlong123`), "login admin");
    ok(typeof adminLogin.token === "string", "admin token");
    const userLogin = okOut(await exec(bash, `db auth login user@x.com pwlong123`), "login user");
    ok(typeof userLogin.token === "string", "user token");

    // verify
    const v = okOut(await exec(bash, `db auth verify --token=${adminLogin.token}`), "verify admin");
    ok(v.user === "admin@x.com" && v.roles.includes("admin"), "admin payload has admin role");

    // user can write
    okOut(await exec(bash, `db notes insert '{"x":1}' --token=${userLogin.token}`), "user insert");

    // user CANNOT drop (admin only)
    okExit(await exec(bash, `db notes drop --token=${userLogin.token}`), 4, "user drop → 4 (no admin role)");

    // admin CAN drop
    await exec(bash, `db trash insert '{"x":1}' --token=${adminLogin.token}`);
    okOut(await exec(bash, `db trash drop --token=${adminLogin.token}`), "admin drop");

    // role assign / remove via admin
    const userId = "u-needs-id"; // we'll find it
    const userDoc = okOut(await exec(bash, `db _users find '{"email":"user@x.com"}'`), "find user doc");
    const realUserId = userDoc[0]._id;

    okOut(await exec(bash, `db auth role assign ${realUserId} editor --token=${adminLogin.token}`), "assign editor");
    okOut(await exec(bash, `db auth role remove ${realUserId} editor --token=${adminLogin.token}`), "remove editor");

    // user cannot assign roles
    okExit(await exec(bash, `db auth role assign ${realUserId} editor --token=${userLogin.token}`), 4, "user role assign → 4");

    // logout invalidates
    okOut(await exec(bash, `db auth logout --token=${userLogin.token}`), "user logout");
    okExit(await exec(bash, `db notes insert '{"x":2}' --token=${userLogin.token}`), 4, "post-logout → 4");

    // bad token
    okExit(await exec(bash, `db notes insert '{"x":1}' --token=garbage`), 4, "garbage token → 4");

    // bad password
    okExit(await exec(bash, `db auth login admin@x.com WRONG`), 4, "bad password → 4");

    // public read still works without token
    okOut(await exec(bash, `db notes find '{}'`), "public find without token");
  }

  // ──────────────────────────────────────────────────────────────────
  section("vec: every quantization × store/get/search/remove");
  {
    for (const q of ["float32", "int8", "polar", "binary"]) {
      const { bash } = buildBash();
      okOut(await exec(bash, `vec create v --dim 8 --quantize ${q}`), `${q}: create`);
      for (let i = 0; i < 5; i++) {
        const vec = Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
        await exec(bash, `vec store v id-${i} '${JSON.stringify(vec)}'`);
      }
      const stats = okOut(await exec(bash, `vec stats v`), `${q}: stats`);
      ok(stats.count === 5 && stats.dim === 8 && stats.quantize === q, `${q}: stats correct`);

      const hits = okOut(await exec(bash, `vec search v '[1,0,0,0,0,0,0,0]' --k 2`), `${q}: search`);
      ok(Array.isArray(hits) && hits.length > 0 && hits[0].id === "id-0", `${q}: top hit is id-0`);

      okOut(await exec(bash, `vec get v id-2`), `${q}: get id-2`);
      okOut(await exec(bash, `vec remove v id-2`), `${q}: remove id-2`);
      okExit(await exec(bash, `vec get v id-2`), 3, `${q}: get id-2 after remove → 3`);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  section("vec: store-batch (clean, with skips, with collision)");
  {
    const { bash } = buildBash();
    okOut(await exec(bash, `vec create v --dim 4`), "create");

    // Use heredoc-style stdin? just-bash supports << and <<<
    // Easier: write JSONL to virtual fs file, batch from there.
    await exec(bash, `echo '{"id":"a","vector":[1,2,3,4]}' > /tmp/in.jsonl`);
    await exec(bash, `echo '{"id":"b","vector":[5,6,7,8]}' >> /tmp/in.jsonl`);
    await exec(bash, `echo '{"id":"c","vector":[1,2]}' >> /tmp/in.jsonl`);  // dim mismatch → skip
    await exec(bash, `echo 'not-json' >> /tmp/in.jsonl`);                    // skip
    await exec(bash, `echo '{"vector":[9,8,7,6]}' >> /tmp/in.jsonl`);        // missing id → skip

    const r = okOut(await exec(bash, `vec store-batch v /tmp/in.jsonl`), "store-batch");
    ok(r.stored === 2, `stored=2 (got ${r.stored})`);
    ok(r.skipped === 3, `skipped=3 (got ${r.skipped})`);
    ok(Array.isArray(r.errors) && r.errors.length === 3, "errors array has 3 entries");

    // Collision: id "a" already exists → exit 5 (whole batch aborts)
    await exec(bash, `echo '{"id":"a","vector":[0,0,0,0]}' > /tmp/clash.jsonl`);
    okExit(await exec(bash, `vec store-batch v /tmp/clash.jsonl`), 5, "id collision → 5");
  }

  // ──────────────────────────────────────────────────────────────────
  section("vec: matryoshka + search-across");
  {
    const { bash } = buildBash();
    okOut(await exec(bash, `vec create a --dim 8`), "create a");
    okOut(await exec(bash, `vec create b --dim 8`), "create b");
    for (let i = 0; i < 6; i++) {
      const vec = Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
      await exec(bash, `vec store a a-${i} '${JSON.stringify(vec)}'`);
      await exec(bash, `vec store b b-${i} '${JSON.stringify(vec)}'`);
    }

    const ms = okOut(await exec(bash, `vec search a '[1,0,0,0,0,0,0,0]' --k 3 --matryoshka 4,6,8`), "matryoshka");
    ok(Array.isArray(ms) && ms.length > 0 && ms[0].id === "a-0", "matryoshka top hit a-0");

    const sa = okOut(await exec(bash, `vec search-across a,b '[0,1,0,0,0,0,0,0]' --k 2`), "search-across");
    ok(sa.length <= 2, `search-across returns ≤k`);
    const ids = sa.map(h => `${h.coll}/${h.id}`);
    ok(ids.includes("a/a-1") || ids.includes("b/b-1"), "search-across top contains a-1 or b-1");
  }

  // ──────────────────────────────────────────────────────────────────
  section("vec: export → drop → re-create → import roundtrip");
  {
    const { bash } = buildBash();
    okOut(await exec(bash, `vec create v --dim 4`), "create");
    for (let i = 0; i < 5; i++) {
      await exec(bash, `vec store v id-${i} '[${i},${i + 1},${i + 2},${i + 3}]' --meta '{"i":${i}}'`);
    }
    const exported = okOut(await exec(bash, `vec export v`), "export");
    ok(exported.exported === 5, "exported 5 records");
    ok(Array.isArray(exported.records) && exported.records.length === 5, "records array len=5");

    okOut(await exec(bash, `vec drop v`), "drop");
    okExit(await exec(bash, `vec stats v`), 3, "stats after drop → 3");

    okOut(await exec(bash, `vec create v --dim 4`), "re-create");
    // Write records to file then import via stdin equivalent — use file path
    await exec(bash, `echo '${JSON.stringify(exported.records).replace(/'/g, "")}' > /tmp/rec.json`);
    const imported = okOut(await exec(bash, `vec import v /tmp/rec.json`), "import");
    ok(imported.imported === 5, "imported 5");
    const stats = okOut(await exec(bash, `vec stats v`), "stats post-import");
    ok(stats.count === 5, "count=5 post-import");
  }

  // ──────────────────────────────────────────────────────────────────
  section("encryption: round-trip across registry instances + raw inspection");
  {
    const fs = new InMemoryFs({});
    const { bash: b1 } = buildBash({ encryptionKey: "secret-k", authSecret: "jwt-s" }, fs);

    okOut(await exec(b1, `db auth register a@x.com pwlong123 --roles=admin`), "shell-1: register");
    const login = okOut(await exec(b1, `db auth login a@x.com pwlong123`), "shell-1: login");
    okOut(await exec(b1, `db notes insert '{"secret":"ULTRA-CONFIDENTIAL-XYZ"}' --token=${login.token}`), "shell-1: insert secret");
    okOut(await exec(b1, `vec create idx --dim 4`), "shell-1: vec create");
    await exec(b1, `vec store idx v1 '[1,2,3,4]'`);

    // Inspect the raw fs files: must NOT contain plaintext markers
    const docsRaw = await fs.readFile("/data/notes.docs.json", "utf8");
    ok(!docsRaw.includes("ULTRA-CONFIDENTIAL-XYZ"), "encrypted: secret string absent in /data/notes.docs.json");

    const usersRaw = await fs.readFile("/data/_users.docs.json", "utf8");
    ok(!usersRaw.includes("a@x.com"), "encrypted: email absent in /data/_users.docs.json");

    // The raw JSON should have the __enc envelope from EncryptedAdapter
    ok(docsRaw.includes("__enc"), "encrypted: __enc envelope present");

    // New Bash on same fs — re-hydrate, decrypt, find secret intact
    const { bash: b2 } = buildBash({ encryptionKey: "secret-k", authSecret: "jwt-s" }, fs);
    const found = okOut(await exec(b2, `db notes find '{}'`), "shell-2: find decrypted");
    ok(found.length === 1 && found[0].secret === "ULTRA-CONFIDENTIAL-XYZ", "shell-2: secret recovered intact");

    const stats2 = okOut(await exec(b2, `vec stats idx`), "shell-2: vec stats");
    ok(stats2.count === 1 && stats2.dim === 4, "shell-2: vec collection rehydrated");

    // Wrong key on same fs → decryption silently returns empty docs (per EncryptedAdapter contract)
    const { bash: b3 } = buildBash({ encryptionKey: "WRONG-KEY", authSecret: "jwt-s" }, fs);
    const wrongFound = okOut(await exec(b3, `db notes find '{}'`), "shell-3: find with wrong key");
    ok(wrongFound.length === 0, "shell-3: wrong key → empty (no plaintext leak)");
  }

  // ──────────────────────────────────────────────────────────────────
  section("persistence without encryption: cross-instance survival");
  {
    const fs = new InMemoryFs({});
    const { bash: b1 } = buildBash({}, fs);
    await exec(b1, `db things insert '{"name":"persistent"}'`);
    await exec(b1, `vec create v --dim 3`);
    await exec(b1, `vec store v keep '[1,2,3]'`);

    const { bash: b2 } = buildBash({}, fs);
    const docs = okOut(await exec(b2, `db things find '{"name":"persistent"}'`), "shell-2: find persisted doc");
    ok(docs.length === 1, "doc survived across instances");

    const got = okOut(await exec(b2, `vec get v keep`), "shell-2: get persisted vector");
    ok(got.id === "keep", "vector survived");
  }

  // ──────────────────────────────────────────────────────────────────
  section("error matrix: every documented exit code reachable");
  {
    // No-auth shell for exits 0/2/3 (auth-orthogonal cases).
    const { bash: bnoauth } = buildBash();
    okOut(await exec(bnoauth, `db users insert '{"a":1}'`), "exit 0: insert no-auth");
    okExit(await exec(bnoauth, `db`), 2, "exit 2: no args");
    okExit(await exec(bnoauth, `db users insert {invalid`), 2, "exit 2: invalid json");
    okExit(await exec(bnoauth, `db users update - -`), 2, "exit 2: two stdin dashes");
    okExit(await exec(bnoauth, `vec create x --dim abc`), 2, "exit 2: bad dim");
    okExit(await exec(bnoauth, `vec create x --dim 99999`), 2, "exit 2: dim too large");
    okExit(await exec(bnoauth, `vec create x --dim 4 --quantize ultra`), 2, "exit 2: bad quantize");
    okExit(await exec(bnoauth, `db ghost find '{}'`), 3, "exit 3: missing collection");
    okExit(await exec(bnoauth, `vec stats ghost`), 3, "exit 3: missing vec collection");

    // Auth shell for exit 4
    const { bash: bauth } = buildBash({ authSecret: "x" });
    okExit(await exec(bauth, `db users insert '{"x":1}'`), 4, "exit 4: write without token");

    // 5: validation (need a token first since authSecret is set)
    await exec(bauth, `db auth register e@x.com pwlong123`);
    const lg = okOut(await exec(bauth, `db auth login e@x.com pwlong123`), "login for validation tests");
    okExit(
      await exec(bauth, `db auth register e@x.com pwlong123 --token=${lg.token}`),
      5,
      "exit 5: duplicate user",
    );
    await exec(bauth, `vec create v --dim 4 --token=${lg.token}`);
    okExit(await exec(bauth, `vec store v a '[1,2]'`), 5, "exit 5: dim mismatch");
    okExit(await exec(bauth, `vec create v --dim 4`), 5, "exit 5: collection exists");
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════`);
  console.log(`Total assertions: ${passed + failed}`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
};

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
