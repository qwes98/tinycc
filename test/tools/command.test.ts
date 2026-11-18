import assert from "node:assert/strict";
import childProcess, { spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatCommandResult,
  runCommand,
  commandToolDefinition,
  type CommandResult,
} from "../../src/tools/command.ts";
import { defineTool, executeTool } from "../../src/tools.ts";
import { runAgent } from "../../src/agent.ts";
import { fileToolDefinition } from "../../src/tools/file.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("command results preserve successful output and describe nonzero exits", () => {
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "42\n",
      stderr: "warning\n",
      exitCode: 0,
    }),
    "42\n",
  );
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    "",
  );
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "",
      stderr: "",
      exitCode: 7,
    }),
    "Command failed: 7",
  );
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "",
      stderr: "boom\n",
      exitCode: 1,
    }),
    "Command failed: 1\nboom\n",
  );
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "partial\n",
      stderr: "",
      exitCode: 3,
    }),
    "Command failed: 3\npartial\n",
  );
  assert.equal(
    formatCommandResult({
      kind: "exited",
      stdout: "partial\n",
      stderr: "reason\n",
      exitCode: 2,
    }),
    "Command failed: 2\npartial\nreason\n",
  );
});

void test("command failure text identifies the cause and warns about partial work", () => {
  const cases: [CommandResult, string][] = [
    [
      {
        kind: "launch_error",
        code: "ENOENT",
        message: "spawn missing ENOENT",
        stdout: "",
        stderr: "",
      },
      "Command could not start (ENOENT): spawn missing ENOENT",
    ],
    [
      { kind: "timeout", timeoutMs: 300, stdout: "partial\n", stderr: "" },
      "Command timed out after 300 ms. Partial work may have occurred; inspect state before retrying.\npartial\n",
    ],
    [
      { kind: "output_limit", maxBufferBytes: 1024, stdout: "", stderr: "" },
      "Command output exceeded 1024 bytes per stream. Output is truncated; partial work may have occurred. Inspect state before retrying.",
    ],
    [
      { kind: "signal", signal: "SIGKILL", stdout: "", stderr: "" },
      "Command terminated by signal: SIGKILL. Partial work may have occurred; inspect state before retrying.",
    ],
  ];
  for (const [result, expected] of cases) {
    assert.equal(formatCommandResult(result), expected);
  }
});

void test("completed command outcomes carry an explicit failure flag", async () => {
  const outcomes: CommandResult[] = [
    { kind: "exited", exitCode: 0, stdout: "", stderr: "warning\n" },
    { kind: "exited", exitCode: 7, stdout: "partial\n", stderr: "" },
    {
      kind: "launch_error",
      code: "ENOENT",
      message: "missing",
      stdout: "",
      stderr: "",
    },
    { kind: "timeout", timeoutMs: 300, stdout: "partial\n", stderr: "" },
    {
      kind: "output_limit",
      maxBufferBytes: 1024,
      stdout: "partial",
      stderr: "",
    },
    { kind: "signal", signal: "SIGKILL", stdout: "partial", stderr: "" },
  ];
  for (const [index, result] of outcomes.entries()) {
    // The fixture order is the oracle: only the first outcome is successful,
    // including when stdout is empty and stderr contains a warning.
    const tool = defineTool({
      ...commandToolDefinition,
      run: async () => result,
    });
    assert.deepEqual(await tool.execute({ command: "unused", args: [] }), {
      content: formatCommandResult(result),
      isError: index !== 0,
    });
  }
});

void test("captured command results match direct process execution", async () => {
  // A synchronous subprocess provides an independent oracle for output and status.
  for (const exitCode of [0, 7]) {
    const args = [
      "-e",
      `process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = ${exitCode}`,
    ];
    const expected = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(expected.error, undefined);
    assert.equal(expected.signal, null);
    assert.equal(expected.status, exitCode);
    assert.deepEqual(await runCommand(process.execPath, args), {
      kind: "exited",
      stdout: expected.stdout,
      stderr: expected.stderr,
      exitCode: expected.status,
    });
  }
});

void test("commands receive literal arguments, the current directory, and closed stdin", async () => {
  const literal = 'spaces ; $(echo unexpected) "quoted"';
  const result = await runCommand(process.execPath, [
    "-e",
    'const fs = require("node:fs"); process.stdout.write(JSON.stringify([process.argv[1], process.cwd(), fs.readFileSync(0, "utf8")]));',
    literal,
  ]);
  assert.equal(result.kind, "exited");
  assert.ok(result.kind === "exited");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [literal, process.cwd(), ""]);
});

void test("command environments omit Anthropic variables while retaining normal execution settings", async () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "anthropic_test_secret",
  ];
  const original = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = "synthetic-secret";
    const result = await runCommand(process.execPath, [
      "-e",
      'process.stdout.write(JSON.stringify({names: Object.keys(process.env).filter(name => name.toUpperCase().startsWith("ANTHROPIC_")), path: process.env.PATH}))',
    ]);
    assert.ok(result.kind === "exited");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      names: [],
      path: process.env.PATH,
    });
    assert.equal(process.env.ANTHROPIC_API_KEY, "synthetic-secret");
  } finally {
    for (const [index, name] of names.entries()) {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    }
  }
});

void test("launch failures resolve and invalid command arguments become error results", async () => {
  const result = await runCommand("/tinycc-missing-executable/run", []);
  assert.equal(result.kind, "launch_error");
  assert.ok(result.kind === "launch_error");
  assert.equal(result.code, "ENOENT");
  assert.match(result.message, /ENOENT/);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  for (const args of [
    null,
    { command: "", args: [] },
    { command: process.execPath, args: [1] },
    { command: process.execPath },
    { command: "bad\0executable", args: [] },
    { command: process.execPath, args: ["bad\0argument"] },
  ]) {
    const failure = await executeTool({
      type: "tool_call",
      name: "run_command",
      arguments: args,
    });
    assert.equal(failure.isError, true);
    assert.match(failure.content, /Invalid tool arguments/);
  }
});

void test("command dispatch preserves process output and reports nonzero exits", async () => {
  for (const exitCode of [0, 7]) {
    const result = await executeTool({
      type: "tool_call",
      name: "run_command",
      arguments: {
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write("42\\n"); process.exitCode = ${exitCode}`,
        ],
      },
    });
    assert.deepEqual(result, {
      content: exitCode === 0 ? "42\n" : "Command failed: 7\n42\n",
      isError: exitCode !== 0,
    });
  }
});

void test(
  "permission and invalid parent path failures resolve as launch failures",
  {
    skip: process.platform === "win32",
  },
  async () => {
    // Use a local temporary filesystem so shared-folder permission emulation cannot mask EACCES.
    const directory = await mkdtemp(join(tmpdir(), "tinycc-command-"));
    try {
      const executable = join(directory, "no-execute");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const result = await runCommand(executable, []);
      assert.equal(result.kind, "launch_error");
      assert.ok(result.kind === "launch_error");
      assert.equal(result.code, "EACCES");
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      // A regular file cannot be a path's parent directory; Node may throw ENOTDIR synchronously.
      const invalidParent = await runCommand(join(executable, "child"), []);
      assert.equal(invalidParent.kind, "launch_error");
      assert.ok(invalidParent.kind === "launch_error");
      assert.equal(invalidParent.code, "ENOTDIR");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  "synchronous OS spawn failures resolve with their original codes",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    // Linux limits individual argument and path lengths. spawnSync independently
    // confirms each OS error; these values are valid JS strings, not malformed host arguments.
    const cases: [string, string[], string][] = [
      [process.execPath, ["x".repeat(1024 * 1024)], "E2BIG"],
      // Avoid shared-folder path handling, which can translate long-path errors into EIO.
      [join(tmpdir(), "x".repeat(8192)), [], "ENAMETOOLONG"],
    ];
    for (const [command, args, code] of cases) {
      const direct = spawnSync(command, args);
      assert.equal(
        (direct.error as NodeJS.ErrnoException | undefined)?.code,
        code,
      );
      const result = await runCommand(command, args);
      assert.equal(result.kind, "launch_error");
      assert.ok(result.kind === "launch_error");
      assert.equal(result.code, code);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  },
);

void test("unexpected errors after spawn reject regardless of code prefix", async (context) => {
  const originalExecFile = childProcess.execFile;
  for (const code of ["EIO", "ERR_SYNTHETIC_FAILURE"]) {
    const failure = Object.assign(
      new Error("Injected child error after spawn"),
      { code },
    );
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    // Keep Node's real callback/error handling. Inject only the child error so the
    // test checks error propagation independently of our classification implementation.
    const replacement = context.mock.method(
      childProcess,
      "execFile",
      (...args: Parameters<typeof originalExecFile>) => {
        const launched = originalExecFile(...args);
        child = launched;
        // events.once would reject on our injected error; close is a separate cleanup signal.
        closed = new Promise<void>((resolve) =>
          launched.once("close", () => resolve()),
        );
        launched.once("spawn", () => {
          setImmediate(() => launched.emit("error", failure));
        });
        return launched;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
        (error) => error === failure,
      );
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
      child?.kill("SIGKILL");
      await closed;
    }
  }
});

void test("signals and output overflow resolve with distinct outcomes and captured output", async () => {
  const signaled = await runCommand(process.execPath, [
    "-e",
    'require("node:fs").writeSync(1, "partial\\n"); process.kill(process.pid, "SIGKILL")',
  ]);
  assert.deepEqual(signaled, {
    kind: "signal",
    signal: "SIGKILL",
    stdout: "partial\n",
    stderr: "",
  });
  const overflow = await runCommand(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(8192))'],
    { maxBufferBytes: 1024 },
  );
  assert.equal(overflow.kind, "output_limit");
  assert.ok(overflow.kind === "output_limit");
  assert.equal(overflow.maxBufferBytes, 1024);
  assert.equal(overflow.stdout, "x".repeat(1024));
});

void test("timeouts preserve partial output and remain distinct from external signals", async () => {
  // A short host-only deadline checks both SIGTERM handlers without slowing normal CLI use.
  for (const handler of ["() => {}", "() => process.exit(0)"]) {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", ${handler}); require("node:fs").writeSync(1, "partial\\n"); setInterval(() => {}, 1000);`,
      ],
      { timeoutMs: 300 },
    );
    assert.deepEqual(result, {
      kind: "timeout",
      timeoutMs: 300,
      stdout: "partial\n",
      stderr: "",
    });
  }
});

void test("invalid host options and invalid executable values still reject", async () => {
  await assert.rejects(
    runCommand(process.execPath, [], { timeoutMs: 0 }),
    RangeError,
  );
  await assert.rejects(runCommand("bad\0executable", []), {
    code: "ERR_INVALID_ARG_VALUE",
  });
});

void test("after timeout the model inspects preserved files and completes only remaining work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tinycc-recovery-"));
  const a = join(directory, "a.txt");
  const b = join(directory, "b.txt");
  const commands: string[][] = [];
  const tools = {
    read_file: defineTool(fileToolDefinition),
    run_command: defineTool({
      ...commandToolDefinition,
      run: async ({ command, args }) => {
        commands.push([...args]);
        return runCommand(command, args, { timeoutMs: 1000 });
      },
    }),
  };
  const initialArgs = [
    "-e",
    // Append makes an unintended retry observable. Use synchronous writes so
    // the captured marker proves both file changes preceded termination.
    'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "done\\n"); fs.writeFileSync(process.argv[2], "partial"); fs.writeSync(1, "files changed\\n"); setInterval(() => {}, 1000);',
    a,
    b,
  ];
  let calls = 0;
  try {
    const reply = await runAgent(
      "Complete both files",
      async (messages) => {
        calls += 1;
        if (calls === 1) {
          return {
            type: "tool_call",
            name: "run_command",
            arguments: { command: process.execPath, args: initialArgs },
          };
        }
        const last = messages.at(-1);
        assert.ok(last?.role === "tool");
        // This scripted model checks the information available for a recovery
        // decision. It does not claim a real model must choose this sequence.
        if (calls === 2) {
          assert.equal(last.isError, true);
          assert.equal(
            last.content,
            "Command timed out after 1000 ms. Partial work may have occurred; inspect state before retrying.\nfiles changed\n",
          );
          assert.equal(commands.length, 1);
          return {
            type: "tool_call",
            name: "read_file",
            arguments: { path: a },
          };
        }
        if (calls === 3) {
          assert.equal(last.isError, false);
          assert.equal(last.content, "done\n");
          return {
            type: "tool_call",
            name: "read_file",
            arguments: { path: b },
          };
        }
        if (calls === 4) {
          assert.equal(last.isError, false);
          assert.equal(last.content, "partial");
          return {
            type: "tool_call",
            name: "run_command",
            arguments: {
              command: process.execPath,
              args: [
                "-e",
                'require("node:fs").writeFileSync(process.argv[1], "complete");',
                b,
              ],
            },
          };
        }
        assert.equal(
          calls,
          5,
          "Recovery must finish without repeating commands",
        );
        assert.equal(last.content, "");
        assert.equal(last.isError, false);
        return "Completed";
      },
      (call) => executeTool(call, tools),
    );
    assert.equal(reply, "Completed");
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0], initialArgs);
    // Read disk independently of the model transcript to detect rollback,
    // duplicate execution, or failure to apply the remaining change.
    assert.equal(await readFile(a, "utf8"), "done\n");
    assert.equal(await readFile(b, "utf8"), "complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the model receives a launch failure and can run a different command", async () => {
  const tools = {
    run_command: defineTool({
      parse: (input: unknown) => {
        assert.ok(typeof input === "string");
        return input;
      },
      run: (command) =>
        runCommand(
          command,
          command === process.execPath
            ? ["-e", 'process.stdout.write("Recovered")']
            : [],
        ),
      // Use JSON to check result fields independently of text formatting.
      format: JSON.stringify,
      isError: commandToolDefinition.isError,
    }),
  };
  let calls = 0;
  const reply = await runAgent(
    "run a command",
    async (messages) => {
      calls += 1;
      const last = messages.at(-1);
      if (calls === 1) {
        return {
          type: "tool_call",
          name: "run_command",
          arguments: "/tinycc-missing-executable/run",
        };
      }
      assert.ok(last?.role === "tool");
      const result = JSON.parse(last.content) as {
        kind: string;
        stdout: string;
      };
      if (calls === 2) {
        assert.equal(result.kind, "launch_error");
        assert.equal(last.isError, true);
        return {
          type: "tool_call",
          name: "run_command",
          arguments: process.execPath,
        };
      }
      assert.equal(calls, 3);
      assert.equal(result.kind, "exited");
      assert.equal(last.isError, false);
      return result.stdout;
    },
    (call) => executeTool(call, tools),
  );
  assert.equal(reply, "Recovered");
  assert.equal(calls, 3);
});
