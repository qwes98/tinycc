import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "../src/agent.ts";
import type { Message, Model } from "../src/model.ts";
import type { ToolCall } from "../src/tools.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("text replies finish immediately and requests have independent histories", async () => {
  const histories: Message[][] = [];
  const model: Model = async (messages) => {
    histories.push(structuredClone([...messages]));
    return "Final reply\n";
  };
  const noTools = async (): Promise<string> => {
    throw new Error("Unexpected tool call");
  };
  assert.equal(await runAgent("first", model, noTools), "Final reply\n");
  assert.equal(await runAgent("second", model, noTools), "Final reply\n");
  assert.deepEqual(histories, [
    [{ role: "user", content: "first" }],
    [{ role: "user", content: "second" }],
  ]);
});

void test("each model call receives the ordered requests and unchanged tool results", async () => {
  const first: ToolCall = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "a.txt" },
  };
  const second: ToolCall = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "b.txt" },
  };
  // An explicit transcript is the oracle; snapshots detect missing or reordered events.
  const transcript: Message[] = [
    { role: "user", content: "inspect" },
    { role: "assistant", content: first },
    { role: "tool", content: "alpha\n" },
    { role: "assistant", content: second },
    { role: "tool", content: "beta\n" },
  ];
  const histories: Message[][] = [];
  const requests: unknown[] = [];
  let completedTools = 0;
  const result = await runAgent(
    "inspect",
    async (messages) => {
      histories.push(structuredClone([...messages]));
      assert.equal(completedTools, histories.length - 1);
      if (histories.length === 1) return first;
      if (histories.length === 2) return second;
      assert.equal(histories.length, 3, "The final reply must end the loop");
      return "Done";
    },
    async (call) => {
      requests.push(call);
      // Resolve on a later microtask to check that execution completes before the next turn.
      await Promise.resolve();
      completedTools += 1;
      return completedTools === 1 ? "alpha\n" : "beta\n";
    },
  );
  assert.equal(result, "Done");
  assert.deepEqual(requests, [first, second]);
  assert.deepEqual(histories, [
    transcript.slice(0, 1),
    transcript.slice(0, 3),
    transcript,
  ]);
});

void test("model and tool failures reject without continuing the request", async () => {
  const failure = new Error("Execution failed");
  let modelCalls = 0;
  await assert.rejects(
    runAgent("fail", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    runAgent(
      "read",
      async () => {
        modelCalls += 1;
        // Fail explicitly if an implementation continues after the rejected tool call.
        if (modelCalls > 1) throw new Error("Model called after tool failure");
        return {
          type: "tool_call",
          name: "read_file",
          arguments: { path: "missing" },
        };
      },
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(modelCalls, 1);
});
