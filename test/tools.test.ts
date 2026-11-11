import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeTool } from "../src/tools.ts";

test("file dispatch forwards the path and preserves the handler result", async () => {
  const paths: string[] = [];
  const tools = {
    read_file: async (path: string) => {
      paths.push(path);
      return "File contents\n";
    },
  };
  const result = await executeTool({
    type: "tool_call", name: "read_file", arguments: { path: "sample.txt" },
  }, tools);
  assert.equal(result, "File contents\n");
  assert.deepEqual(paths, ["sample.txt"]);
  // Different names ensure the error identifies the actual request.
  for (const name of ["missing", "other_tool"]) {
    await assert.rejects(executeTool({
      // @ts-expect-error Invalid external tool names must still be rejected at runtime.
      type: "tool_call", name, arguments: { path: "sample.txt" },
    }, tools), { message: `Unknown tool: ${name}` });
  }
  assert.deepEqual(paths, ["sample.txt"]);
});

test("file tool results match direct filesystem reads", async () => {
  // The filesystem is the independent reference; preserve trailing newlines in tool results.
  for (const path of ["fixtures/project.txt", "fixtures/notes.txt"]) {
    const expected = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.equal(await executeTool({
      type: "tool_call", name: "read_file", arguments: { path },
    }), expected);
  }
});
