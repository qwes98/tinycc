import type { ToolCall } from "./tools.ts";

/** Ordered events for one request. Tool results preserve the complete tool output. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: ToolCall }
  | { role: "tool"; content: string };

/**
 * Accepts request history and resolves to final text or a tool request; failures reject.
 * History may be extended after resolution. Implementations must copy it to retain a snapshot.
 */
export type Model = (
  messages: readonly Message[],
) => Promise<string | ToolCall>;

/**
 * Returns deterministic requests without network access. File results drive subsequent replies.
 * "inspect" requests two files sequentially; "read" returns the supplied file result.
 * "command" and "command-error" request one command and return its supplied result unchanged.
 */
export const fakeModel: Model = async (messages) => {
  const first = messages[0];
  if (first?.role !== "user") throw new Error("Expected a user message");
  const prompt = first.content;
  const results = messages.filter((message) => message.role === "tool");
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
