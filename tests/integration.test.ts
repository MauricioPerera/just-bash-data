import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { createDataPlugin } from "../src/index.js";

const buildBash = (
  fs: InMemoryFs,
  pluginOpts: Parameters<typeof createDataPlugin>[0] = {},
): Bash =>
  new Bash({
    fs,
    customCommands: createDataPlugin(pluginOpts),
  });

describe("integration: db end-to-end via Bash", () => {
  it("insert + find + count round-trip in shell pipeline", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs);

    const insertResult = await bash.exec(
      `db users insert '{"name":"Alice","age":30}'`,
    );
    expect(insertResult.exitCode).toBe(0);

    const found = await bash.exec(`db users find '{"name":"Alice"}'`);
    expect(found.exitCode).toBe(0);
    const arr = JSON.parse(found.stdout) as Array<{ name: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]?.name).toBe("Alice");

    const countResult = await bash.exec(`db users count '{}'`);
    expect(countResult.exitCode).toBe(0);
    expect(JSON.parse(countResult.stdout)).toEqual({ count: 1 });
  });

  it("sequential mutating commands persist via the plugin's flush boundary", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs);

    await bash.exec(`db x insert '{"a":1}'`);
    await bash.exec(`db x insert '{"a":2}'`);
    await bash.exec(`db x insert '{"a":3}'`);

    const written = await fs.readFile("/data/x.docs.json", "utf8");
    const docs = JSON.parse(written) as Array<{ a: number }>;
    expect(docs.map((d) => d.a).sort()).toEqual([1, 2, 3]);
  });
});

describe("integration: vec RAG-style flow via Bash", () => {
  it("create + store-batch + search returns expected ranking", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs);

    expect((await bash.exec(`vec create docs --dim 4`)).exitCode).toBe(0);

    // Three vectors in JSONL format. Pipe via heredoc-like single quoted echo + |.
    const insertA = await bash.exec(`vec store docs a '[1,0,0,0]'`);
    expect(insertA.exitCode).toBe(0);
    const insertB = await bash.exec(`vec store docs b '[0,1,0,0]'`);
    expect(insertB.exitCode).toBe(0);
    const insertC = await bash.exec(`vec store docs c '[0,0,1,0]'`);
    expect(insertC.exitCode).toBe(0);

    const searchResult = await bash.exec(`vec search docs '[1,0,0,0]' --k 2`);
    expect(searchResult.exitCode).toBe(0);
    const hits = JSON.parse(searchResult.stdout) as Array<{ id: string; score: number }>;
    expect(hits[0]?.id).toBe("a");
    expect(hits.length).toBe(2);
  });
});

describe("integration: auth flow via Bash", () => {
  it("register → login → write-with-token → logout → write-fails", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs, { authSecret: "integration-secret" });

    expect(
      (await bash.exec(`db auth register alice@x.com s3cret123`)).exitCode,
    ).toBe(0);

    const loginRes = await bash.exec(`db auth login alice@x.com s3cret123`);
    expect(loginRes.exitCode).toBe(0);
    const { token } = JSON.parse(loginRes.stdout) as { token: string };

    const insertRes = await bash.exec(`db notes insert '{"x":1}' --token=${token}`);
    expect(insertRes.exitCode).toBe(0);

    const logoutRes = await bash.exec(`db auth logout --token=${token}`);
    expect(logoutRes.exitCode).toBe(0);

    const insertAfter = await bash.exec(`db notes insert '{"x":2}' --token=${token}`);
    expect(insertAfter.exitCode).toBe(4);
    expect(insertAfter.stderr).toMatch(/auth:/);
  });

  it("read paths remain public without a token", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs, { authSecret: "s3cret" });

    await bash.exec(`db auth register u@x.com aaaaaa`);
    const login = JSON.parse(
      (await bash.exec(`db auth login u@x.com aaaaaa`)).stdout,
    ) as { token: string };

    await bash.exec(`db notes insert '{"y":1}' --token=${login.token}`);
    const findRes = await bash.exec(`db notes find '{}'`);
    expect(findRes.exitCode).toBe(0);
    expect(JSON.parse(findRes.stdout)).toHaveLength(1);
  });
});

describe("integration: encryption", () => {
  it("doc plaintext does not appear in the persisted file", async () => {
    const fs = new InMemoryFs({});
    const bash = buildBash(fs, { encryptionKey: "test-key" });

    await bash.exec(`db notes insert '{"secret":"PLAINTEXT-MARKER-XYZ"}'`);

    const raw = await fs.readFile("/data/notes.docs.json", "utf8");
    expect(raw).not.toContain("PLAINTEXT-MARKER-XYZ");
  });
});
