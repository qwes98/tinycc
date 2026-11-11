import type { ToolCall } from "./tools.ts";

/**
 * Accepts one prompt and resolves to reply text or one tool request, or rejects on failure.
 * Sessions depend on this function signature so model implementations can change independently.
 */
export type Model = (prompt: string) => Promise<string | ToolCall>;

/**
 * Returns fixed responses without network requests: "hello" resolves to "tinycc ready",
 * "read" requests a fixture file, "fail" rejects, and other prompts resolve to text.
 */
export const fakeModel: Model = async (prompt) => {
  if (prompt === "read") {
    return { type: "tool_call", name: "read_file", arguments: { path: "fixtures/project.txt" } };
  }
  if (prompt === "fail") {
    throw new Error("Fake model connection failed");
  }
  if (prompt === "hello") {
    return "tinycc ready";
  }
  return `Fake response: ${prompt}`;
};
