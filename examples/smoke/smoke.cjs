// CJS smoke test: same scenarios via require().
const { Bash, InMemoryFs } = require("just-bash");
const { createDataPlugin } = require("just-bash-data");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

(async () => {
  console.log("[cjs] requiring… OK");
  console.log(`[cjs] createDataPlugin type: ${typeof createDataPlugin}`);

  const fs = new InMemoryFs({});
  const bash = new Bash({
    fs,
    customCommands: createDataPlugin({}),
  });

  let r = await bash.exec(`db users insert '{"name":"Bob","age":42}'`);
  assert(r.exitCode === 0, "insert exits 0");

  r = await bash.exec(`db users find '{"age":{"$gte":18}}'`);
  assert(r.exitCode === 0, "find exits 0");
  const docs = JSON.parse(r.stdout);
  assert(docs.length === 1 && docs[0].name === "Bob", "find returned Bob");

  r = await bash.exec(`vec create x --dim 3`);
  assert(r.exitCode === 0, "vec create exits 0");

  r = await bash.exec(`vec store x v1 '[1,2,3]' --meta '{"tag":"smoke"}'`);
  assert(r.exitCode === 0, "vec store exits 0");

  r = await bash.exec(`vec stats x`);
  assert(r.exitCode === 0, "vec stats exits 0");
  const stats = JSON.parse(r.stdout);
  assert(stats.count === 1 && stats.dim === 3, `stats {count:1,dim:3} (got ${JSON.stringify(stats)})`);

  console.log("\n[cjs] all smoke assertions passed");
})().catch((err) => {
  console.error("[cjs] uncaught:", err);
  process.exit(1);
});
