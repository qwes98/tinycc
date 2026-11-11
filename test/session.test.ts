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
  const session = createSession(async (messages) => {
    const first = messages[0];
    assert.ok(first?.role === "user");
    calls.push(first.content);
    return "Test response";
  }, (text) => output.push(text));

  for (const command of ["hello", "stats", "command", "batch 3", "exit"]) {
    await session.execute(command);
  }
  await session.execute("stats");
  assert.deepEqual(calls, ["hello", "hello", "hello", "hello"]);
  assert.equal(output.at(-1), `model_calls=${calls.length}`);
  assert.ok(output.includes("Command not available: command"));
});

test("a file request returns its result to the model before display", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("read"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, ["tinycc fixture", "model_calls=2"]);
});

test("inspect completes two sequential file requests with three model calls", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("inspect"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, ["Inspected two files", "model_calls=3"]);
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

test("later model failures and tool validation failures preserve counts and session recovery", async () => {
  for (const scenario of ["later-model", "invalid-tool"]) {
    const output: string[] = [];
    const session = createSession(async (messages) => {
      const first = messages[0];
      assert.ok(first?.role === "user");
      if (first.content === "hello") return "Recovered";
      if (messages.length > 1) throw new Error("Later model failed");
      return {
        type: "tool_call", name: "read_file",
        arguments: { path: scenario === "later-model" ? "fixtures/project.txt" : 42 },
      };
    }, (text) => output.push(text));
    assert.equal(await session.execute("read"), "error");
    await session.execute("stats");
    assert.equal(await session.execute("hello"), "continue");
    await session.execute("stats");
    assert.deepEqual(output, scenario === "later-model" ? [
      "Error: Later model failed", "model_calls=2", "Recovered", "model_calls=3",
    ] : [
      "Error: Invalid tool arguments: expected { path: string }",
      "model_calls=1", "Recovered", "model_calls=2",
    ]);
  }
});
