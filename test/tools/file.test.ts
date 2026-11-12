import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeTool } from "../../src/tools.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("file tool results match direct filesystem reads", async () => {
  // The filesystem is the independent reference; preserve trailing newlines in tool results.
  for (const path of ["fixtures/project.txt", "fixtures/notes.txt"]) {
    const expected = await readFile(
      new URL(`../../${path}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      await executeTool({
        type: "tool_call",
        name: "read_file",
        arguments: { path },
      }),
      expected,
    );
  }
});
