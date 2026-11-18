import type { ToolCall, ToolResult } from "./tools.ts";

/** A tool request with optional user-facing text from the same model response. */
export type ToolResponse = ToolCall & { text?: string };

/** Ordered history for one request. Tool results preserve the complete tool output. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: ToolCall }
  | ({ role: "tool" } & ToolResult);

/**
 * Accepts history and resolves to final text or a tool request with optional intermediate text.
 * Missing or empty intermediate text requires no display. Failures reject.
 * History may be extended after resolution. Implementations must copy it to retain a snapshot.
 */
export type Model = (
  messages: readonly Message[],
) => Promise<string | ToolResponse>;

/**
 * Returns deterministic requests without network access. File results drive subsequent replies.
 * "inspect" requests two files sequentially; "read" returns the supplied file result.
 * "command" and "command-error" request one command and return its supplied result unchanged.
 * "progress" supplies intermediate text with a file request, then a distinct final reply.
 * "recover" corrects a bad file argument after reading its failed tool result.
 */
export const fakeModel: Model = async (messages) => {
  const first = messages[0];
  if (first?.role !== "user") throw new Error("Expected a user message");
  const prompt = first.content;
  const results = messages.filter((message) => message.role === "tool");
  if (prompt === "recover") {
    if (results.length === 0)
      return {
        type: "tool_call",
        name: "read_file",
        arguments: { path: 42 },
        text: "I will inspect the project file.",
      };
    if (results.length === 1) {
      if (!results[0]!.isError)
        throw new Error("Expected a failed tool result");
      return {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "fixtures/project.txt" },
        text: "I will correct the file path argument.",
      };
    }
    const last = results.at(-1)!;
    return last.isError ? last.content : `Recovered: ${last.content}`;
  }
  if (prompt === "progress") {
    if (results.length > 0)
      return results[0]!.isError ? results[0]!.content : "Inspection complete";
    return {
      type: "tool_call",
      name: "read_file",
      arguments: { path: "fixtures/project.txt" },
      text: "I will read the project file.",
    };
  }
  if (prompt === "command" || prompt === "command-error") {
    if (results.length > 0) return results[0]!.content;
    return {
      type: "tool_call",
      name: "run_command",
      arguments: {
        command: process.execPath,
        args: [
          "-e",
          prompt === "command"
            ? 'process.stdout.write("42\\n")'
            : "process.exit(7)",
        ],
      },
    };
  }
  if (prompt === "read" || prompt === "inspect") {
    const failed = results.find((result) => result.isError);
    if (failed) return failed.content;
    if (results.length === 0) {
      return {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "fixtures/project.txt" },
      };
    }
    if (prompt === "read") return results[0]!.content;
    if (results.length === 1) {
      return {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "fixtures/notes.txt" },
      };
    }
    return "Inspected two files";
  }
  if (prompt === "fail") {
    throw new Error("Fake model connection failed");
  }
  if (prompt === "hello") {
    return "tinycc ready";
  }
  return `Fake response: ${prompt}`;
};
