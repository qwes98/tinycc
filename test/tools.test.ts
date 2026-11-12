import assert from "node:assert/strict";
import test from "node:test";
import { defineTool, executeTool } from "../src/tools.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("file dispatch forwards the path and preserves the handler result", async () => {
  const paths: string[] = [];
  const tools = {
    read_file: defineTool({
      parse: (input) => {
        assert.deepEqual(input, { path: "sample.txt" });
        return { path: "sample.txt" };
      },
      run: async ({ path }) => {
        paths.push(path);
        return "File contents\n";
      },
      format: (text) => text,
    }),
  };
  const result = await executeTool(
    {
      type: "tool_call",
      name: "read_file",
      arguments: { path: "sample.txt" },
    },
    tools,
  );
  assert.equal(result, "File contents\n");
  assert.deepEqual(paths, ["sample.txt"]);
  // Different names ensure the error identifies the actual request.
  for (const name of ["missing", "other_tool", "toString"]) {
    await assert.rejects(
      executeTool(
        {
          type: "tool_call",
          name,
          arguments: { path: "sample.txt" },
        },
        tools,
      ),
      { message: `Unknown tool: ${name}` },
    );
  }
  assert.deepEqual(paths, ["sample.txt"]);
});

void test("a registry accepts tools with different arguments and structured results", async () => {
  const tools = {
    count: defineTool({
      parse: (input) => {
        if (typeof input !== "number") throw new Error("Expected a number");
        return input;
      },
      run: async (value) => ({ doubled: value * 2 }),
      format: (result) => JSON.stringify(result),
    }),
  };
  // A parsed model request exercises a tool absent from the built-in registry.
  const request: unknown = JSON.parse(
    '{"type":"tool_call","name":"count","arguments":3}',
  );
  assert.equal(await executeTool(request, tools), '{"doubled":6}');
});

void test("invalid input is rejected before a tool runs", async () => {
  let runs = 0;
  const tools = {
    count: defineTool({
      parse: (input) => {
        if (typeof input !== "number") throw new Error("Expected a number");
        return input;
      },
      run: async (value) => {
        runs += 1;
        return value;
      },
      format: String,
    }),
  };
  for (const request of [
    null,
    { type: "message", name: "count", arguments: 3 },
    { type: "tool_call", name: "count" },
  ]) {
    await assert.rejects(executeTool(request, tools), /Invalid tool call/);
  }
  await assert.rejects(
    executeTool(
      {
        type: "tool_call",
        name: "count",
        arguments: "3",
      },
      tools,
    ),
    { message: "Expected a number" },
  );
  assert.equal(runs, 0);

  await assert.rejects(
    executeTool({
      type: "tool_call",
      name: "read_file",
      arguments: { path: 42 },
    }),
    /Invalid tool arguments/,
  );
});

void test("execution failures propagate without formatting a result", async () => {
  const failure = new Error("Read failed");
  let formats = 0;
  const tools = {
    failing: defineTool({
      parse: (input) => input,
      run: async (): Promise<string> => {
        throw failure;
      },
      format: (text) => {
        formats += 1;
        return text;
      },
    }),
  };
  await assert.rejects(
    executeTool(
      {
        type: "tool_call",
        name: "failing",
        arguments: {},
      },
      tools,
    ),
    (error) => error === failure,
  );
  assert.equal(formats, 0);
});
