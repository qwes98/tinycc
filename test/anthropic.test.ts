import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnthropicModel } from "../src/anthropic.ts";
import { runAgent } from "../src/agent.ts";
import { executeTool } from "../src/tools.ts";
import type { Message } from "../src/model.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

/** Builds API-shaped responses; values are independent fixtures, not adapter output. */
function reply(content: unknown[], stop_reason = "end_turn"): Response {
  return Response.json({
    type: "message",
    role: "assistant",
    content,
    stop_reason,
  });
}

void test("Claude receives an error result with its request ID and chooses a corrected file call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinycc-api-recovery-"));
  try {
    const missing = join(directory, "missing.txt");
    const present = join(directory, "present.txt");
    await writeFile(present, "Recovered contents\n");
    const failedContent = [
      { type: "text", text: "Reading." },
      { type: "thinking", thinking: "opaque", signature: "retained" },
      {
        type: "tool_use",
        id: "failed-id",
        name: "read_file",
        input: { path: missing },
      },
    ];
    const correctedContent = [
      {
        type: "tool_use",
        id: "corrected-id",
        name: "read_file",
        input: { path: present },
      },
    ];
    let requests = 0;
    let executions = 0;
    const model = createAnthropicModel({
      apiKey: "test-key",
      model: "test-model",
      fetcher: async (_url, init) => {
        assert.ok(typeof init?.body === "string");
        const body = JSON.parse(init.body) as {
          messages: { role: string; content: unknown }[];
        };
        if (++requests === 1) return reply(failedContent, "tool_use");
        assert.deepEqual(body.messages[1], {
          role: "assistant",
          content: failedContent,
        });
        const failed = body.messages[2]?.content as {
          type: string;
          tool_use_id: string;
          content: string;
          is_error: boolean;
        }[];
        assert.equal(failed[0]?.type, "tool_result");
        assert.equal(failed[0]?.tool_use_id, "failed-id");
        assert.equal(failed[0]?.is_error, true);
        assert.match(failed[0]!.content, /ENOENT/);
        assert.equal(
          executions,
          requests - 1,
          "Each model response executes one request without host retries",
        );
        if (requests === 2) {
          assert.equal(body.messages.length, 3);
          return reply(correctedContent, "tool_use");
        }
        assert.equal(requests, 3);
        assert.deepEqual(body.messages[3], {
          role: "assistant",
          content: correctedContent,
        });
        assert.deepEqual(body.messages[4], {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "corrected-id",
              content: "Recovered contents\n",
            },
          ],
        });
        return reply([{ type: "text", text: "Recovered" }]);
      },
    });
    assert.equal(
      await runAgent("Read a file", model, async (call) => {
        executions += 1;
        return executeTool(call);
      }),
      "Recovered",
    );
    assert.equal(executions, 2);
    assert.equal(requests, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an unknown tool name reaches Claude as a failed result instead of a transport failure", async () => {
  const original = [
    {
      type: "tool_use",
      id: "unknown-request",
      name: "missing_tool",
      input: {},
    },
  ];
  let calls = 0;
  const model = createAnthropicModel({
    apiKey: "test",
    model: "test",
    fetcher: async (_url, init) => {
      if (++calls === 1) return reply(original, "tool_use");
      assert.equal(
        calls,
        2,
        "The model may finish after an error without retrying",
      );
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as { messages: unknown[] };
      assert.deepEqual(body.messages.slice(1), [
        { role: "assistant", content: original },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "unknown-request",
              content: "Unknown tool: missing_tool",
              is_error: true,
            },
          ],
        },
      ]);
      return reply([{ type: "text", text: "That tool is unavailable" }]);
    },
  });
  assert.equal(await runAgent("Use a tool", model), "That tool is unavailable");
  assert.equal(calls, 2);
});

void test("tool responses expose only user text and preserve original API blocks and IDs", async () => {
  const content = [
    { type: "text", text: "Read " },
    { type: "thinking", thinking: "private", signature: "opaque" },
    { type: "text", text: "file." },
    {
      type: "tool_use",
      id: "visible-text",
      name: "read_file",
      input: { path: "a" },
    },
  ];
  let requests = 0;
  const model = createAnthropicModel({
    apiKey: "test",
    model: "test",
    fetcher: async (_url, init) => {
      if (++requests === 1) return reply(content, "tool_use");
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as { messages: unknown[] };
      assert.deepEqual(body.messages, [
        { role: "user", content: "read" },
        { role: "assistant", content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "visible-text",
              content: " raw\n",
            },
          ],
        },
      ]);
      return reply([{ type: "text", text: "Done" }]);
    },
  });
  const call = await model([{ role: "user", content: "read" }]);
  assert.ok(typeof call !== "string");
  assert.equal(call.text, "Read file.");
  assert.equal(
    await model([
      { role: "user", content: "read" },
      { role: "assistant", content: call },
      { role: "tool", content: " raw\n", isError: false },
    ]),
    "Done",
  );
});

void test("tool responses without text stay silent and malformed text rejects", async () => {
  const tool = {
    type: "tool_use",
    id: "silent",
    name: "read_file",
    input: { path: "a" },
  };
  for (const blocks of [
    [tool],
    [{ type: "text", text: "" }, tool],
    [{ type: "text", text: 42 }, tool],
  ]) {
    const model = createAnthropicModel({
      apiKey: "test",
      model: "test",
      fetcher: async () => reply(blocks, "tool_use"),
    });
    if (
      blocks.some((block) => "text" in block && typeof block.text !== "string")
    ) {
      await assert.rejects(
        model([{ role: "user", content: "read" }]),
        /Invalid Anthropic text block/,
      );
    } else {
      const call = await model([{ role: "user", content: "read" }]);
      assert.ok(typeof call !== "string");
      assert.equal(call.text, undefined);
    }
  }
});

void test("Claude tool IDs and complete assistant blocks survive file and command execution", async () => {
  const requests: Record<string, unknown>[] = [];
  const readContent = [
    { type: "text", text: "I will inspect the file." },
    {
      type: "thinking",
      thinking: "Inspect first",
      signature: "opaque-signature",
    },
    {
      type: "tool_use",
      id: "tool-read",
      name: "read_file",
      input: { path: "fixtures/project.txt" },
    },
  ];
  const commandContent = [
    {
      type: "tool_use",
      id: "tool-command",
      name: "run_command",
      input: {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("42\\n")'],
      },
    },
  ];
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.ok(init);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("anthropic-version"), "2026-10-21");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(typeof init.body, "string");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push(body);
      assert.equal(body.model, "test-model");
      assert.equal(body.max_tokens, 4096);
      assert.deepEqual(body.tool_choice, {
        type: "auto",
        disable_parallel_tool_use: true,
      });
      assert.match(
        String(body.system),
        /Inspect affected state before retrying/,
      );
      const tools = body.tools as { name: string; input_schema: unknown }[];
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_file", "run_command"],
      );
      assert.ok(tools.every((tool) => tool.input_schema));
      if (requests.length === 1) return reply(readContent, "tool_use");
      if (requests.length === 2) return reply(commandContent, "tool_use");
      assert.equal(requests.length, 3, "Final text must stop execution");
      return reply([
        { type: "text", text: "Done" },
        { type: "text", text: "\n" },
      ]);
    },
  });
  const executed: string[] = [];
  assert.equal(
    await runAgent("Inspect and calculate", model, async (call) => {
      assert.ok(
        typeof call === "object" &&
          call !== null &&
          "name" in call &&
          typeof call.name === "string",
      );
      executed.push(call.name);
      return executeTool(call);
    }),
    "Done\n",
  );
  assert.deepEqual(executed, ["read_file", "run_command"]);
  // This explicit wire transcript catches lost text/signatures, wrong IDs,
  // reordered results, trimming, and accidental accumulation across requests.
  const transcript = [
    { role: "user", content: "Inspect and calculate" },
    { role: "assistant", content: readContent },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-read",
          content: "tinycc fixture\n",
        },
      ],
    },
    { role: "assistant", content: commandContent },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-command", content: "42\n" },
      ],
    },
  ];
  assert.deepEqual(
    requests.map((request) => request.messages),
    [transcript.slice(0, 1), transcript.slice(0, 3), transcript],
  );
});

void test("timeout text reaches Claude unchanged and the adapter does not retry the command", async () => {
  let requests = 0;
  let executions = 0;
  const output =
    "Command timed out after 300 ms. Partial work may have occurred; inspect state before retrying.\npartial\n";
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async (_url, init) => {
      requests += 1;
      if (requests === 1)
        return reply(
          [
            {
              type: "tool_use",
              id: "timeout-id",
              name: "run_command",
              input: { command: "example", args: [] },
            },
          ],
          "tool_use",
        );
      assert.equal(requests, 2);
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as { messages: unknown[] };
      assert.deepEqual(body.messages.at(-1), {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "timeout-id",
            content: output,
            is_error: true,
          },
        ],
      });
      return reply([
        {
          type: "text",
          text: "Inspect the partial changes before continuing.",
        },
      ]);
    },
  });
  assert.equal(
    await runAgent("Run", model, async () => {
      executions += 1;
      return { content: output, isError: true };
    }),
    "Inspect the partial changes before continuing.",
  );
  assert.equal(executions, 1);
});

void test("one adapter keeps independent requests and repeated tool names paired correctly", async () => {
  let requests = 0;
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async (_url, init) => {
      requests += 1;
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as {
        messages: { content: unknown }[];
      };
      if (requests % 2 === 1) {
        assert.equal(body.messages.length, 1);
        return reply(
          [
            {
              type: "tool_use",
              id: `id-${requests}`,
              name: "read_file",
              input: { path: "file" },
            },
          ],
          "tool_use",
        );
      }
      assert.deepEqual(body.messages.at(-1), {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `id-${requests - 1}`,
            content: "value",
          },
        ],
      });
      return reply([{ type: "text", text: "Done" }]);
    },
  });
  for (const prompt of ["first", "second"])
    assert.equal(
      await runAgent(prompt, model, async () => ({
        content: "value",
        isError: false,
      })),
      "Done",
    );
  assert.equal(requests, 4);
});

void test("incomplete and malformed responses cannot execute a tool or report success", async () => {
  const tool = {
    type: "tool_use",
    id: "id",
    name: "run_command",
    input: { command: "unused", args: [] },
  };
  const cases = [
    { stop_reason: "max_tokens", content: [tool] },
    { stop_reason: "max_tokens", content: [{ type: "text", text: 42 }] },
    { stop_reason: "end_turn", content: [tool] },
    {
      stop_reason: "pause_turn",
      content: [{ type: "text", text: "unfinished" }],
    },
    { stop_reason: "tool_use", content: [tool, { ...tool, id: "second" }] },
    { stop_reason: "tool_use", content: [{ ...tool, name: "bad\nname" }] },
    { stop_reason: "tool_use", content: [{ ...tool, id: "" }] },
    { stop_reason: "tool_use", content: [{ ...tool, input: null }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: 42 }] },
    { stop_reason: "end_turn", content: [null] },
    { stop_reason: "end_turn", content: [] },
  ];
  const expectedErrors = [
    /stopped with max_tokens/,
    /stopped with max_tokens/,
    /stopped with end_turn/,
    /stopped with pause_turn/,
    /Expected exactly one Anthropic tool request/,
    /Invalid Anthropic tool request/,
    /Invalid Anthropic tool request/,
    /Invalid Anthropic tool request/,
    /no valid final text/,
    /Invalid Anthropic API response/,
    /no valid final text/,
  ];
  for (const [index, response] of cases.entries()) {
    let requests = 0;
    const model = createAnthropicModel({
      apiKey: "test-key",
      model: "test-model",
      fetcher: async () => {
        requests += 1;
        return Response.json(response);
      },
    });
    await assert.rejects(
      runAgent("Run", model, async () =>
        assert.fail("Invalid response executed a tool"),
      ),
      expectedErrors[index]!,
    );
    assert.equal(requests, 1);
  }
});

void test("copied and foreign tool requests reject before another HTTP request", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return reply(
      [
        {
          type: "tool_use",
          id: "original-id",
          name: "read_file",
          input: { path: "file" },
        },
      ],
      "tool_use",
    );
  };
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher,
  });
  const call = await model([{ role: "user", content: "read" }]);
  assert.ok(typeof call !== "string");
  const foreignModel = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher,
  });
  await assert.rejects(
    model([
      { role: "user", content: "read" },
      { role: "assistant", content: structuredClone(call) },
      { role: "tool", content: "value", isError: false },
    ]),
    /Unknown tool request in model history/,
  );
  await assert.rejects(
    foreignModel([
      { role: "user", content: "read" },
      { role: "assistant", content: call },
      { role: "tool", content: "value", isError: false },
    ]),
    /Unknown tool request in model history/,
  );
  assert.equal(requests, 1);
});

void test("history rejects missing and orphan results before dispatch and preserves an empty result", async () => {
  let requests = 0;
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async (_url, init) => {
      requests += 1;
      if (requests === 1)
        return reply(
          [
            {
              type: "tool_use",
              id: "history-id",
              name: "read_file",
              input: { path: "file" },
            },
          ],
          "tool_use",
        );
      assert.equal(requests, 2);
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as { messages: unknown[] };
      assert.deepEqual(body.messages.at(-1), {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "history-id", content: "" },
        ],
      });
      return reply([{ type: "text", text: "Done" }]);
    },
  });
  const user: Message = { role: "user", content: "read" };
  const call = await model([user]);
  assert.ok(typeof call !== "string");
  const assistant: Message = { role: "assistant", content: call };
  const result: Message = { role: "tool", content: "", isError: false };
  const cases: [Message[], RegExp][] = [
    [[result], /Tool result has no matching request/],
    [[user, assistant], /Missing tool result in model history/],
    [[user, assistant, user], /Missing tool result in model history/],
    [[user, assistant, assistant], /Missing tool result in model history/],
    [[user, assistant, result, result], /Tool result has no matching request/],
  ];
  for (const [history, expected] of cases) {
    await assert.rejects(model(history), expected);
    assert.equal(requests, 1, "Invalid history must not reach HTTP dispatch");
  }
  // Failed conversion must not leave pending state behind for the next call.
  assert.equal(await model([user, assistant, result]), "Done");
  assert.equal(requests, 2);
});

void test("HTTP failures and request deadlines reject without automatic network retries", async () => {
  let requests = 0;
  // A real local HTTP transport checks fetch cancellation while waiting for a response.
  const server = createServer((request, response) => {
    requests += 1;
    if (request.url === "/fail") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "private-content" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const path of ["fail", "timeout"]) {
      const model = createAnthropicModel({
        apiKey: "test-key",
        model: "test-model",
        timeoutMs: 300,
        fetcher: (_url, init) =>
          fetch(`http://127.0.0.1:${address.port}/${path}`, init),
      });
      await assert.rejects(
        model([{ role: "user", content: "hello" }]),
        path === "fail" ? /HTTP 429/ : { name: "TimeoutError" },
      );
    }
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

void test("missing configuration fails before networking", () => {
  assert.throws(
    () => createAnthropicModel({ apiKey: "", model: "test-model" }),
    /ANTHROPIC_API_KEY/,
  );
  assert.throws(
    () => createAnthropicModel({ apiKey: "test-key", model: " " }),
    /ANTHROPIC_MODEL/,
  );
  assert.throws(
    () =>
      createAnthropicModel({
        apiKey: "test-key",
        model: "test-model",
        timeoutMs: 0,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      createAnthropicModel({
        apiKey: "synthetic\nprivate-key",
        model: "test-model",
      }),
    (error) =>
      error instanceof Error &&
      error.message ===
        "ANTHROPIC_API_KEY must be a single printable ASCII token",
  );
});

void test("invalid JSON errors do not expose response body contents", async () => {
  const model = createAnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async () => new Response("synthetic-private-content"),
  });
  await assert.rejects(
    model([{ role: "user", content: "hello" }]),
    (error) =>
      error instanceof Error &&
      error.message === "Invalid JSON in Anthropic API response",
  );
});
