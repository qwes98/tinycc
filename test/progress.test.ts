import assert from "node:assert/strict";
import test from "node:test";
import { formatProgress } from "../src/progress.ts";
import type { ToolCall } from "../src/tools.ts";

void test("progress formatting preserves visible content on labelled lines", () => {
  const call: ToolCall = {
    type: "tool_call",
    name: "read_file",
    arguments: { path: "a\nb" },
  };
  assert.equal(
    formatProgress({ type: "assistant_text", text: "Reading\nnow" }),
    '[assistant] "Reading\\nnow"',
  );
  assert.equal(
    formatProgress({ type: "tool_start", call }),
    '[tool:start] read_file {"path":"a\\nb"}',
  );
  assert.equal(
    formatProgress({ type: "tool_end", call, result: " raw\n" }),
    '[tool:end] read_file " raw\\n"',
  );
  assert.equal(
    formatProgress({ type: "tool_end", call, result: "" }),
    '[tool:end] read_file ""',
  );
  assert.equal(
    formatProgress({ type: "tool_error", call, error: "missing" }),
    '[tool:error] read_file "missing"',
  );
  assert.equal(
    formatProgress({ type: "tool_error", call, error: "denied" }),
    '[tool:error] read_file "denied"',
  );
});
