import assert from "node:assert/strict";
import test from "node:test";
import { defineTool, executeTool } from "../src/tools.ts";
import { ToolError } from "../src/tools/result.ts";

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
  assert.deepEqual(result, { content: "File contents\n", isError: false });
  assert.deepEqual(paths, ["sample.txt"]);
  // Different names ensure the error identifies the actual request.
  for (const name of ["missing", "other_tool", "toString"]) {
    assert.deepEqual(
      await executeTool(
        {
          type: "tool_call",
          name,
          arguments: { path: "sample.txt" },
        },
        tools,
      ),
      { content: `Unknown tool: ${name}`, isError: true },
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
  assert.deepEqual(await executeTool(request, tools), {
    content: '{"doubled":6}',
    isError: false,
  });
});

void test("invalid input returns a failed result before a tool runs", async () => {
  let runs = 0;
  const tools = {
    count: defineTool({
      parse: (input) => {
        if (typeof input !== "number") throw new ToolError("Expected a number");
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
    const result = await executeTool(request, tools);
    assert.equal(result.isError, true);
    assert.match(result.content, /Invalid tool call/);
  }
  assert.deepEqual(
    await executeTool(
      {
        type: "tool_call",
        name: "count",
        arguments: "3",
      },
      tools,
    ),
    { content: "Expected a number", isError: true },
  );
  assert.equal(runs, 0);

  assert.deepEqual(
    await executeTool({
      type: "tool_call",
      name: "read_file",
      arguments: { path: 42 },
    }),
    {
      content: "Invalid tool arguments: expected { path: string }",
      isError: true,
    },
  );
});

void test("expected execution failures resolve without formatting and internal defects still reject", async () => {
  const expected = new ToolError("Unavailable file");
  let formats = 0;
  const tool = defineTool({
    parse: (input) => input,
    run: async (): Promise<string> => {
      throw expected;
    },
    format: (text) => {
      formats += 1;
      return text;
    },
  });
  assert.deepEqual(await tool.execute({}), {
    content: expected.message,
    isError: true,
  });
  assert.equal(formats, 0);
  // Only parse/run owns expected tool failures. Formatting and classification are host code.
  for (const stage of ["parse", "format", "isError"] as const) {
    const failure =
      stage === "parse"
        ? new TypeError("Internal parse defect")
        : new ToolError("Host defect");
    const broken = defineTool({
      parse: (input) => {
        if (stage === "parse") throw failure;
        return input;
      },
      run: async () => "raw",
      format: (text) => {
        if (stage === "format") throw failure;
        return text;
      },
      isError: () => {
        if (stage === "isError") throw failure;
        return false;
      },
    });
    await assert.rejects(broken.execute({}), (error) => error === failure);
  }
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
