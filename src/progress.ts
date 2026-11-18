import type { AgentEvent } from "./agent.ts";

/**
 * Formats one progress event for display, without modifying model history or tool output.
 * JSON quoting keeps multiline arguments, results, and errors on one labelled line.
 * Final text is handled separately by the session. Serialization errors throw to the caller.
 * @returns One line without a trailing newline; the CLI supplies that newline on stderr.
 */
export function formatProgress(event: AgentEvent): string {
  switch (event.type) {
    case "assistant_text":
      return `[assistant] ${JSON.stringify(event.text)}`;
    case "tool_start":
      return `[tool:start] ${event.call.name} ${JSON.stringify(event.call.arguments)}`;
    case "tool_end":
      return `[tool:end] ${event.call.name} ${JSON.stringify(event.result)}`;
    case "tool_error":
      return `[tool:error] ${event.call.name} ${JSON.stringify(event.error)}`;
  }
}
