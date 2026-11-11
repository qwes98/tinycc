import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the CLI produces the expected output for piped input", () => {
  // Resolve relative to this test file, so the path does not depend on the working directory.
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  // Use the current Node executable and a real subprocess to check input and output wiring.
  const result = spawnSync(process.execPath, [cli], {
    input: "stats\nbatch 3\nstats\nfail\nstats\nexit\n",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "model_calls=0",
    "tinycc ready",
    "tinycc ready",
    "tinycc ready",
    "model_calls=3",
    "Error: Fake model connection failed",
    "model_calls=4",
    "",
  ].join("\n"));
});
