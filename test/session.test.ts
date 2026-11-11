import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel } from "../src/model.ts";
import { createSession } from "../src/session.ts";

test("hello prints the fixed readiness response", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("hello"), "continue");
  assert.deepEqual(output, ["tinycc ready"]);
});

test("model call counts match an independent call log", async () => {
  // Record actual invocations independently of the counter reported by stats.
  const calls: string[] = [];
  const output: string[] = [];
  const session = createSession(async (prompt) => {
    calls.push(prompt);
    return "Test response";
  }, (text) => output.push(text));

  for (const command of ["hello", "stats", "inspect", "batch 3", "exit"]) {
    await session.execute(command);
  }
  await session.execute("stats");
  assert.deepEqual(calls, ["hello", "hello", "hello", "hello"]);
  assert.equal(output.at(-1), `model_calls=${calls.length}`);
  assert.ok(output.includes("Command not available: inspect"));
});

test("a file request displays its result with one model call", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("read"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, ["tinycc fixture", "model_calls=1"]);
});

test("the session accepts another command after a model failure", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("fail"), "error");
  assert.equal(await session.execute("hello"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, [
    "Error: Fake model connection failed",
    "tinycc ready",
    "model_calls=2",
  ]);
});
