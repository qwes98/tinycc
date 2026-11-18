import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type AgentEvent } from "../src/agent.ts";
import type { Message, Model } from "../src/model.ts";
import type { ToolCall, ToolResult } from "../src/tools.ts";

void test("a failed result reaches the model and its next request can recover", async () => {
  const first: ToolCall = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "missing" },
  };
  const second: ToolCall = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "present" },
  };
  const failure: ToolResult = { content: "File not found\n", isError: true };
  const success: ToolResult = { content: "Actual contents\n", isError: false };
  const transcript: Message[] = [
    { role: "user", content: "inspect" },
    { role: "assistant", content: first },
    { role: "tool", ...failure },
    { role: "assistant", content: second },
    { role: "tool", ...success },
  ];
  const events: AgentEvent[] = [];
  const histories: Message[][] = [];
  const executed: unknown[] = [];
  const result = await runAgent(
    "inspect",
    async (history) => {
      histories.push([...history]);
      if (histories.length === 1) return first;
      if (histories.length === 2) {
        assert.equal(events.at(-1)?.type, "tool_error");
        return second;
      }
      assert.equal(histories.length, 3, "No host retry or extra model call");
      return "Recovered";
    },
    async (call) => {
      executed.push(call);
      // A custom executor may carry extra metadata; only the result contract enters history.
      return {
        ...(call === first ? failure : success),
        role: "assistant",
        debug: "internal",
      };
    },
    (event) => {
      events.push(event);
    },
  );
  assert.equal(result, "Recovered");
  assert.deepEqual(executed, [first, second]);
  assert.deepEqual(histories, [
    transcript.slice(0, 1),
    transcript.slice(0, 3),
    transcript,
  ]);
  assert.deepEqual(events, [
    { type: "tool_start", call: first },
    { type: "tool_error", call: first, error: failure.content },
    { type: "tool_start", call: second },
    { type: "tool_end", call: second, result: success.content },
  ]);
  const errorEvent = events[1];
  assert.ok(errorEvent?.type === "tool_error");
  assert.equal(errorEvent.call, first, "Keep the failed request's identity");
});

void test("failure-display errors reject before the failed result can reach the model", async () => {
  const call = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "missing" },
  } as const;
  const displayFailure = new Error("Display failed");
  const events: AgentEvent[] = [];
  let calls = 0;
  await assert.rejects(
    runAgent(
      "read",
      async () => {
        assert.equal(++calls, 1, "No model call after display failure");
        return call;
      },
      async () => ({ content: "missing", isError: true }),
      (event) => {
        events.push(event);
        if (event.type === "tool_error") throw displayFailure;
      },
    ),
    (error) => error === displayFailure,
  );
  assert.deepEqual(events, [
    { type: "tool_start", call },
    { type: "tool_error", call, error: "missing" },
  ]);
});

void test("progress follows actual execution and final text is returned only", async () => {
  const call = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "a.txt" },
    text: "Reading.",
  } as const;
  const events: AgentEvent[] = [];
  let calls = 0;
  const final = await runAgent(
    "read",
    async (history) => {
      calls += 1;
      if (calls === 1) return call;
      assert.equal(calls, 2);
      assert.deepEqual(
        events.map((event) => event.type),
        ["assistant_text", "tool_start", "tool_end"],
      );
      assert.equal(
        history[1]?.content,
        call,
        "Preserve original request identity",
      );
      assert.deepEqual(history[2], {
        role: "tool",
        content: " raw\n",
        isError: false,
      });
      return "Done\n";
    },
    async (request) => {
      assert.equal(request, call);
      assert.deepEqual(events, [
        { type: "assistant_text", text: "Reading." },
        { type: "tool_start", call },
      ]);
      await Promise.resolve();
      assert.equal(events.length, 2, "Do not finish before tool resolution");
      return { content: " raw\n", isError: false };
    },
    (event) => {
      events.push(event);
    },
  );
  assert.equal(final, "Done\n");
  assert.deepEqual(events, [
    { type: "assistant_text", text: "Reading." },
    { type: "tool_start", call },
    { type: "tool_end", call, result: " raw\n" },
  ]);
});

void test("missing intermediate text stays silent and empty tool output still completes", async () => {
  for (const text of [undefined, ""]) {
    const call = {
      type: "tool_call",
      name: "read_file",
      arguments: { path: "empty" },
      text,
    } as const;
    const events: AgentEvent[] = [];
    let calls = 0;
    assert.equal(
      await runAgent(
        "empty",
        async () => (++calls === 1 ? call : "Done"),
        async () => ({ content: "", isError: false }),
        (event) => {
          events.push(event);
        },
      ),
      "Done",
    );
    assert.deepEqual(events, [
      { type: "tool_start", call },
      { type: "tool_end", call, result: "" },
    ]);
  }
});

void test("unexpected tool rejection stops without producing a model-visible result", async () => {
  const call = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "missing" },
  } as const;
  const error = new Error("missing");
  const events: AgentEvent[] = [];
  let calls = 0;
  await assert.rejects(
    runAgent(
      "read",
      async () => {
        assert.equal(++calls, 1, "Stop after tool rejection");
        return call;
      },
      async () => {
        throw error;
      },
      (event) => {
        events.push(event);
      },
    ),
    (caught) => caught === error,
  );
  assert.deepEqual(events, [{ type: "tool_start", call }]);
});

void test("observer failures stop work without being reported as tool failures", async () => {
  for (const failAt of ["assistant_text", "tool_start", "tool_end"]) {
    const failure = new Error("Display failed");
    const events: AgentEvent[] = [];
    const call = {
      type: "tool_call",
      name: "read_file",
      arguments: { path: "a" },
      text: "Reading.",
    } as const;
    let modelCalls = 0;
    let toolCalls = 0;
    await assert.rejects(
      runAgent(
        "read",
        async () => {
          assert.equal(++modelCalls, 1, "Model ran after display failure");
          return call;
        },
        async () => {
          toolCalls += 1;
          assert.equal(failAt, "tool_end", "Tool ran after display failure");
          return { content: "data", isError: false };
        },
        (event) => {
          events.push(event);
          if (event.type === failAt) throw failure;
        },
      ),
      (error) => error === failure,
    );
    const expected: AgentEvent[] = [
      { type: "assistant_text", text: "Reading." },
      { type: "tool_start", call },
      { type: "tool_end", call, result: "data" },
    ];
    assert.deepEqual(
      events,
      expected.slice(
        0,
        ["assistant_text", "tool_start", "tool_end"].indexOf(failAt) + 1,
      ),
    );
    assert.equal(toolCalls, failAt === "tool_end" ? 1 : 0);
  }
});

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("text replies finish immediately and requests have independent histories", async () => {
  const histories: Message[][] = [];
  const model: Model = async (messages) => {
    histories.push(structuredClone([...messages]));
    return "Final reply\n";
  };
  const noTools = async (): Promise<ToolResult> => {
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
    { role: "tool", content: "alpha\n", isError: false },
    { role: "assistant", content: second },
    { role: "tool", content: "beta\n", isError: false },
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
      return {
        content: completedTools === 1 ? "alpha\n" : "beta\n",
        isError: false,
      };
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
