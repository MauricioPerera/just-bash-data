// ESM smoke test: exercise the public API as a downstream consumer would.
import { Bash, InMemoryFs } from "just-bash";
import { createDataPlugin } from "just-bash-data";

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

const main = async () => {
  console.log("[esm] importing… OK");
  console.log(`[esm] createDataPlugin type: ${typeof createDataPlugin}`);

  const fs = new InMemoryFs({});
  const bash = new Bash({
    fs,
    customCommands: createDataPlugin({
      authSecret: "smoke-jwt-secret",
      encryptionKey: "smoke-key",
    }),
  });

  // 1. Auth bootstrap
  let r = await bash.exec(`db auth register alice@x.com pwlong123 --roles=admin`);
  assert(r.exitCode === 0, `auth register exits 0 (got ${r.exitCode}, stderr=${r.stderr})`);

  r = await bash.exec(`db auth login alice@x.com pwlong123`);
  assert(r.exitCode === 0, "auth login exits 0");
  const { token } = JSON.parse(r.stdout);
  assert(typeof token === "string" && token.length > 30, "received a JWT");

  // 2. Doc CRUD with token
  r = await bash.exec(`db notes insert '{"title":"hello","body":"world"}' --token=${token}`);
  assert(r.exitCode === 0, "db insert exits 0 with token");

  r = await bash.exec(`db notes find '{}'`);
  assert(r.exitCode === 0, "db find (public) exits 0");
  const docs = JSON.parse(r.stdout);
  assert(Array.isArray(docs) && docs.length === 1, "find returned 1 doc");
  assert(docs[0].title === "hello", "doc has expected title");

  // 3. Vec RAG-style flow
  r = await bash.exec(`vec create docs --dim 4`);
  assert(r.exitCode === 0, "vec create exits 0");

  for (const [id, vec] of [["a", "[1,0,0,0]"], ["b", "[0,1,0,0]"], ["c", "[0,0,1,0]"]]) {
    r = await bash.exec(`vec store docs ${id} '${vec}'`);
    assert(r.exitCode === 0, `vec store ${id} exits 0`);
  }

  r = await bash.exec(`vec search docs '[1,0,0,0]' --k 2`);
  assert(r.exitCode === 0, "vec search exits 0");
  const hits = JSON.parse(r.stdout);
  assert(hits[0].id === "a", `top hit is "a" (got ${hits[0]?.id})`);

  // 4. Encryption check: raw on-disk file must not contain plaintext title
  const raw = await fs.readFile("/data/notes.docs.json", "utf8");
  assert(!raw.includes("hello"), "encrypted: 'hello' not present in raw file");
  assert(!raw.includes("world"), "encrypted: 'world' not present in raw file");

  // 5. Auth enforcement: write without token after logout
  r = await bash.exec(`db auth logout --token=${token}`);
  assert(r.exitCode === 0, "logout exits 0");

  r = await bash.exec(`db notes insert '{"x":1}' --token=${token}`);
  assert(r.exitCode === 4, `revoked token rejected with exit 4 (got ${r.exitCode})`);

  console.log("\n[esm] all smoke assertions passed");
};

main().catch((err) => {
  console.error("[esm] uncaught:", err);
  process.exit(1);
});
