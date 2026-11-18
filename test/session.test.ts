import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel } from "../src/model.ts";
import { createSession } from "../src/session.ts";
import type { AgentEvent } from "../src/agent.ts";

void test("session forwards progress separately and writes final text once", async () => {
  const events: AgentEvent[] = [];
  const output: string[] = [];
  const session = createSession(
    fakeModel,
    (text) => output.push(text),
    (event) => {
      events.push(event);
    },
  );
  assert.equal(await session.execute("progress"), "continue");
  assert.deepEqual(
    events.map((event) => event.type),
    ["assistant_text", "tool_start", "tool_end"],
  );
  assert.deepEqual(output, ["Inspection complete"]);
});

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("hello prints the fixed readiness response", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("hello"), "continue");
  assert.deepEqual(output, ["tinycc ready"]);
});

void test("literal prompts bypass local commands and share the attempted call counter", async () => {
  const prompts: string[] = [];
  const output: string[] = [];
  const session = createSession(
    async (messages) => {
      const first = messages[0];
      assert.ok(first?.role === "user");
      prompts.push(first.content);
      return "Reply";
    },
    (text) => output.push(text),
  );
  for (const prompt of ["exit", "help", "batch 20", "  hello  "])
    await session.ask(prompt);
  await assert.rejects(session.ask("  "), /Prompt must not be empty/);
  await session.execute("stats");
  assert.deepEqual(prompts, ["exit", "help", "batch 20", "  hello  "]);
  assert.deepEqual(output, [
    "Reply",
    "Reply",
    "Reply",
    "Reply",
    "model_calls=4",
  ]);
});

void test("nonzero command exits return to the model and the session continues", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("command-error"), "continue");
  await session.execute("stats");
  assert.equal(await session.execute("command"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, [
    "Command failed: 7",
    "model_calls=2",
    "42",
    "model_calls=4",
  ]);
});

void test("model call counts match an independent call log", async () => {
  // Record actual invocations independently of the counter reported by stats.
  const calls: string[] = [];
  const output: string[] = [];
  const session = createSession(
    async (messages) => {
      const first = messages[0];
      assert.ok(first?.role === "user");
      calls.push(first.content);
      return "Test response";
    },
    (text) => output.push(text),
  );

  for (const command of ["hello", "stats", "command", "batch 3", "exit"]) {
    await session.execute(command);
  }
  await session.execute("stats");
  assert.deepEqual(calls, ["hello", "command", "hello", "hello", "hello"]);
  assert.equal(output.at(-1), `model_calls=${calls.length}`);
});

void test("a file request returns its result to the model before display", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("read"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, ["tinycc fixture", "model_calls=2"]);
});

void test("inspect completes two sequential file requests with three model calls", async () => {
  const output: string[] = [];
  const session = createSession(fakeModel, (text) => output.push(text));
  assert.equal(await session.execute("inspect"), "continue");
  await session.execute("stats");
  assert.deepEqual(output, ["Inspected two files", "model_calls=3"]);
});

void test("the session accepts another command after a model failure", async () => {
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

void test("later model failures stop while tool validation failures allow a model response", async () => {
  for (const scenario of ["later-model", "invalid-tool"]) {
    const output: string[] = [];
    const session = createSession(
      async (messages) => {
        const first = messages[0];
        assert.ok(first?.role === "user");
        if (first.content === "hello") return "Recovered";
        if (messages.length > 1) {
          const result = messages.at(-1);
          assert.ok(result?.role === "tool");
          assert.equal(result.isError, scenario === "invalid-tool");
          if (scenario === "invalid-tool") return "A valid path is needed";
          throw new Error("Later model failed");
        }
        return {
          type: "tool_call",
          name: "read_file",
          arguments: {
            path: scenario === "later-model" ? "fixtures/project.txt" : 42,
          },
        };
      },
      (text) => output.push(text),
    );
    assert.equal(
      await session.execute("read"),
      scenario === "invalid-tool" ? "continue" : "error",
    );
    await session.execute("stats");
    assert.equal(await session.execute("hello"), "continue");
    await session.execute("stats");
    assert.deepEqual(
      output,
      scenario === "later-model"
        ? [
            "Error: Later model failed",
            "model_calls=2",
            "Recovered",
            "model_calls=3",
          ]
        : [
            "A valid path is needed",
            "model_calls=2",
            "Recovered",
            "model_calls=3",
          ],
    );
  }
});
