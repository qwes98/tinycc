import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { executeTool } from "../../src/tools.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("unexpected filesystem failures reject instead of becoming model input", async () => {
  const failure = Object.assign(new Error("Internal I/O failure"), {
    code: "EIO",
  });
  const reader = mock.method(filesystem, "readFile", async () => {
    throw failure;
  });
  // Node built-in named imports need synchronization after mocking the default export.
  // This file's tests run sequentially; restore both exports before the next test.
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      executeTool({
        type: "tool_call",
        name: "read_file",
        arguments: { path: "any.txt" },
      }),
      (error) => error === failure,
    );
  } finally {
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("file tool results match direct filesystem reads", async () => {
  // The filesystem is the independent reference; preserve trailing newlines in tool results.
  for (const path of ["fixtures/project.txt", "fixtures/notes.txt"]) {
    const expected = await readFile(
      new URL(`../../${path}`, import.meta.url),
      "utf8",
    );
    assert.deepEqual(
      await executeTool({
        type: "tool_call",
        name: "read_file",
        arguments: { path },
      }),
      { content: expected, isError: false },
    );
  }
});

void test("file input and ordinary filesystem failures are recoverable tool results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinycc-file-result-"));
  const path = join(directory, "present.txt");
  try {
    await writeFile(path, "contents\n");
    for (const [input, expected] of [
      [42, /Invalid tool arguments/],
      ["bad\0path", /must not contain null bytes/],
      [join(directory, "missing"), /ENOENT/],
      [join(path, "child"), /ENOTDIR/],
    ] as const) {
      const result = await executeTool({
        type: "tool_call",
        name: "read_file",
        arguments: { path: input },
      });
      assert.equal(result.isError, true);
      assert.match(result.content, expected);
    }
    // Root bypasses mode bits; only assert permission denial when the OS enforces them.
    if (process.getuid?.() !== 0) {
      await chmod(path, 0);
      const result = await executeTool({
        type: "tool_call",
        name: "read_file",
        arguments: { path },
      });
      assert.equal(result.isError, true);
      assert.match(result.content, /EACCES|EPERM/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
