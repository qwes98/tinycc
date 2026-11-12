import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("command demos print model replies and exit successfully for both process statuses", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const [demo, output] of [
    ["command", "42\n"],
    ["command-error", "Command failed: 7\n"],
  ]) {
    const result = spawnSync(process.execPath, [cli, "--demo", demo], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output);
    assert.equal(result.stderr, "");
  }
});

void test("inspect demo prints only the final response and exits successfully", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--demo", "inspect"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Inspected two files\n");
  assert.equal(result.stderr, "");
});

void test("the CLI produces the expected output for piped input", () => {
  // Resolve relative to this test file, so the path does not depend on the working directory.
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  // Use the current Node executable and a real subprocess to check input and output wiring.
  const result = spawnSync(process.execPath, [cli], {
    input: "stats\nbatch 3\nstats\nfail\nstats\nexit\n",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "model_calls=0",
      "tinycc ready",
      "tinycc ready",
      "tinycc ready",
      "model_calls=3",
      "Error: Fake model connection failed",
      "model_calls=4",
      "",
    ].join("\n"),
  );
});

void test("Anthropic mode reports missing configuration and invalid arguments before execution", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const [args, expected] of [
    [["--model", "anthropic", "--prompt", "hello"], /ANTHROPIC_API_KEY/],
    [["--model", "unknown"], /Usage:/],
    [["--model", "anthropic", "--prompt"], /Usage:/],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      // Explicit empty exports take precedence over any local .env credentials.
      env: { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" },
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /at .*cli\.ts/);
  }
});

void test("Anthropic CLI completes tool requests in one-shot and piped sessions", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  // Install a transport fixture before loading the actual CLI. The real adapter,
  // environment selection, agent loop, file tool, and display path still run.
  const preload =
    "data:text/javascript," +
    encodeURIComponent(`
    import assert from "node:assert/strict";
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer cli-test-key");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "cli-test-model");
      if (body.messages.length === 1) {
        return Response.json({ stop_reason: "tool_use", content: [
          { type: "tool_use", id: "cli-file", name: "read_file", input: { path: "fixtures/project.txt" } }
        ] });
      }
      assert.equal(body.messages.length, 3);
      const result = body.messages[2].content[0];
      assert.equal(result.tool_use_id, "cli-file");
      assert.equal(result.content, "tinycc fixture\\n");
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: result.content }] });
    };
  `);
  for (const prompt of [
    "Inspect the fixture",
    "exit",
    "help",
    "batch 20",
    "  ",
    null,
  ]) {
    const oneShot = prompt !== null;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        cli,
        "--model",
        "anthropic",
        ...(oneShot ? ["--prompt", prompt] : []),
      ],
      {
        input: oneShot ? undefined : "Inspect the fixture\nstats\nexit\n",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "cli-test-key",
          ANTHROPIC_MODEL: "cli-test-model",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (prompt === "  ") {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Prompt must not be empty/);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      oneShot ? "tinycc fixture\n" : "tinycc fixture\nmodel_calls=2\n",
    );
  }
});

void test("Anthropic CLI loads its root .env independently of cwd and respects exported values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinycc-config-"));
  try {
    // Copy only public source into an isolated checkout; never read or replace a user's .env.
    await cp(
      fileURLToPath(new URL("../src", import.meta.url)),
      join(directory, "src"),
      { recursive: true },
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, ".env"),
      "ANTHROPIC_API_KEY=file-test-key\nANTHROPIC_MODEL=file-test-model\n",
    );
    const preload =
      "data:text/javascript," +
      encodeURIComponent(`
      import assert from "node:assert/strict";
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + process.env.EXPECTED_KEY);
        const body = JSON.parse(init.body);
        assert.equal(body.model, process.env.EXPECTED_MODEL);
        return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "Configured" }] });
      };
    `);
    for (const exported of [false, true]) {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_MODEL;
      if (exported) {
        env.ANTHROPIC_API_KEY = "export-test-key";
        env.ANTHROPIC_MODEL = "export-test-model";
      }
      env.EXPECTED_KEY = exported ? "export-test-key" : "file-test-key";
      env.EXPECTED_MODEL = exported ? "export-test-model" : "file-test-model";
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          join(directory, "src/cli.ts"),
          "--model",
          "anthropic",
          "--prompt",
          "hello",
        ],
        {
          cwd: tmpdir(),
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "Configured\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
