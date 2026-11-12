import { execFile, type ChildProcess } from "node:child_process";
import type { ToolDefinition } from "../tools.ts";

/**
 * A process outcome with captured UTF-8 output. Only "exited" has a numeric exit code.
 * Timeout, output limit, and signal outcomes may contain partial output and partial side effects;
 * callers must tell the model to inspect state before retrying these commands.
 * A kind identifies the observed outcome, not whether retrying is safe or useful.
 */
export type CommandResult = {
  stdout: string;
  stderr: string;
} & (
  | { kind: "exited"; exitCode: number }
  | { kind: "launch_error"; code: string; message: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "output_limit"; maxBufferBytes: number }
  | { kind: "signal"; signal: NodeJS.Signals }
);

/** Host-controlled limits. Model arguments cannot override these settings. */
type CommandOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
};

/**
 * Runs an executable with literal arguments in the current working directory, without a shell.
 * Resolves to an outcome for exits, OS launch errors, signals, timeout, and output overflow.
 * Invalid host arguments/options and unexpected internal failures reject; callers report them.
 * Defaults: 10-second timeout and 1 MiB per stream. Overrides are host-only, also used in tests.
 * Resource limits use SIGKILL so a direct child cannot ignore termination or exit as success.
 * Termination does not roll back side effects or manage descendant processes.
 * Child stdin is closed immediately; interactive commands are not supported.
 */
export async function runCommand(
  command: string,
  args: string[],
  { timeoutMs = 10_000, maxBufferBytes = 1024 * 1024 }: CommandOptions = {},
): Promise<CommandResult> {
  // Use the timer's supported positive range for both host-controlled limits.
  // Invalid settings reject before execution; they are not outcomes of a command.
  for (const limit of [timeoutMs, maxBufferBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647) {
      throw new RangeError("Command limits must be positive 32-bit integers");
    }
  }
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let spawned = false;
    let child: ChildProcess;
    try {
      child = execFile(
        command,
        args,
        {
          encoding: "utf8",
          maxBuffer: maxBufferBytes,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          const output = { stdout, stderr };
          // Classification precedence is part of the result contract: overflow wins over
          // an observed timeout, and both win over the signal used to stop the child.
          // This chooses one outcome; it does not reconstruct the order of competing causes.
          if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            // maxBuffer counts bytes separately for stdout and stderr; output may be truncated.
            resolve({ ...output, kind: "output_limit", maxBufferBytes });
          } else if (timedOut) {
            resolve({ ...output, kind: "timeout", timeoutMs });
          } else if (error?.signal) {
            // The signal alone identifies neither its sender nor the underlying cause.
            // The child may signal itself; this outcome does not imply an external interruption.
            resolve({ ...output, kind: "signal", signal: error.signal });
          } else if (!error) {
            // stderr may contain warnings even on success; output content is not an exit status.
            resolve({ ...output, kind: "exited", exitCode: 0 });
          } else if (typeof error.code === "number") {
            // execFile reports nonzero exits as errors, but they remain completed command outcomes.
            resolve({ ...output, kind: "exited", exitCode: error.code });
          } else if (!spawned && typeof error.code === "string") {
            // With these execFile options, an asynchronous error before the spawn event
            // reports launch failure (e.g. ENOENT/EACCES). Synchronous errors are handled below.
            // Once spawn succeeds, an unrelated error must reject regardless of its code prefix.
            // No shell is involved, so a missing executable is a spawn error, not shell exit 127.
            resolve({
              ...output,
              kind: "launch_error",
              code: error.code,
              message: error.message,
            });
          } else {
            // Keep unclassified failures visible to the caller instead of disguising them
            // as command results. The model receives only outcomes handled above.
            reject(error);
          }
        },
      );
    } catch (error) {
      // Node throws some OS launch failures synchronously (e.g. E2BIG/ENAMETOOLONG).
      // Check the failed system call, not a code prefix. Argument validation errors do
      // not identify a spawn syscall and must still reject. Restrict this catch to
      // execFile itself so later runtime errors cannot be reclassified as launch failures.
      if (
        error instanceof Error &&
        "syscall" in error &&
        error.syscall === "spawn" &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        resolve({
          kind: "launch_error",
          code: error.code,
          message: error.message,
          stdout: "",
          stderr: "",
        });
      } else {
        reject(error);
      }
      return;
    }
    // Node emits spawn before other child events on success, and omits it on launch failure.
    // Track this public lifecycle event instead of inferring execution state from error names.
    child.once("spawn", () => {
      spawned = true;
    });
    // Track the cause ourselves: execFile's callback otherwise reports both a timeout
    // and an external SIGKILL as a signal. Resolve only after the callback collects output.
    // This timer schedules a termination attempt, not a deadline for Promise completion.
    const timer = setTimeout(() => {
      // true means the signal was sent, not that exit is complete. A failed send leaves
      // timedOut false; only a successful timer-triggered send selects the timeout branch.
      timedOut = child.kill("SIGKILL");
    }, timeoutMs);
    child.stdin?.end();
  });
}

/**
 * Converts a completed process result into text for the model.
 * "exited" with code 0 returns stdout unchanged. Other outcomes use the following headers:
 * - exited: "Command failed: <exitCode>"
 * - launch_error: "Command could not start (<code>): <message>"
 * - timeout: "Command timed out after <timeoutMs> ms. Partial work may have occurred; inspect state before retrying."
 * - output_limit: "Command output exceeded <maxBufferBytes> bytes per stream. Output is truncated; partial work may have occurred. Inspect state before retrying."
 * - signal: "Command terminated by signal: <signal>. Partial work may have occurred; inspect state before retrying."
 * Append one newline and stdout + stderr to a failure header only when either has content.
 * Stream contents are never trimmed. This synchronous conversion performs no I/O.
 */
export function formatCommandResult(result: CommandResult): string {
  let header: string;
  switch (result.kind) {
    case "exited":
      if (result.exitCode === 0) return result.stdout;
      header = `Command failed: ${result.exitCode}`;
      break;
    case "launch_error":
      header = `Command could not start (${result.code}): ${result.message}`;
      break;
    case "timeout":
      header = `Command timed out after ${result.timeoutMs} ms. Partial work may have occurred; inspect state before retrying.`;
      break;
    case "output_limit":
      header = `Command output exceeded ${result.maxBufferBytes} bytes per stream. Output is truncated; partial work may have occurred. Inspect state before retrying.`;
      break;
    case "signal":
      header = `Command terminated by signal: ${result.signal}. Partial work may have occurred; inspect state before retrying.`;
      break;
  }
  const output = result.stdout + result.stderr;
  return output.length > 0 ? `${header}\n${output}` : header;
}

/** Returns literal executable arguments or throws before starting a process. */
function parseCommandArguments(input: unknown): {
  command: string;
  args: string[];
} {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("command" in input) ||
    !("args" in input) ||
    typeof input.command !== "string" ||
    input.command.length === 0 ||
    !Array.isArray(input.args) ||
    !input.args.every((arg: unknown) => typeof arg === "string")
  ) {
    throw new Error(
      "Invalid tool arguments: expected { command: nonempty string, args: string[] }",
    );
  }
  return { command: input.command, args: input.args };
}

/** Command argument validation, process execution, and result formatting. */
export const commandToolDefinition = {
  parse: parseCommandArguments,
  run: ({ command, args }) => runCommand(command, args),
  format: formatCommandResult,
} satisfies ToolDefinition<{ command: string; args: string[] }, CommandResult>;
