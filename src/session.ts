import type { Model } from "./model.ts";
import { runAgent } from "./agent.ts";

type Outcome = "continue" | "exit" | "error";

const unavailableCommands = new Set(["command", "command-error"]);

/**
 * Creates a command handler with its own model call counter.
 * @param model Async function that turns request history into text or one tool request.
 * @param write Receives each reply or status message; the caller controls where it goes.
 * @returns An execute function that shares this session's counter across calls.
 */
export function createSession(model: Model, write: (text: string) => void) {
  let modelCalls = 0;

  /** Runs one isolated request and displays final text; failures propagate to execute. */
  async function ask(prompt: string) {
    const result = await runAgent(prompt, async (messages) => {
      // Count every attempted call, including later turns and rejected calls.
      modelCalls += 1;
      return model(messages);
    });
    // Remove one display newline only after the model has consumed unmodified tool results.
    write(result.endsWith("\n") ? result.slice(0, -1) : result);
  }

  /**
   * Accepts one input line and writes any resulting messages through write.
   * Resolves to "continue" for handled input, "exit" for an exit request,
   * or "error" when a model, tool, or batch validation failure has been reported.
   * The caller decides whether to stop reading input; "exit" does not close the session.
   */
  async function execute(input: string): Promise<Outcome> {
    const line = input.trim();
    // Handle local commands before model dispatch; they do not increment modelCalls.
    if (line === "") return "continue";
    if (line === "exit") return "exit";
    if (line === "help") {
      write(
        "hello | read | inspect | stats | batch <1..20> | fail | exit\nOther input is sent to the fake model.\nUnavailable: command, command-error",
      );
      return "continue";
    }
    if (line === "stats") {
      write(`model_calls=${modelCalls}`);
      return "continue";
    }
    if (unavailableCommands.has(line)) {
      write(`Command not available: ${line}`);
      return "continue";
    }

    try {
      if (line === "batch" || line.startsWith("batch ")) {
        const parts = line.split(/\s+/);
        const count = Number(parts[1]);
        if (
          parts.length !== 2 ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > 20
        ) {
          throw new Error("Usage: batch <1..20>");
        }
        // Await each reply to preserve output order. A failure stops the remaining calls.
        for (let index = 0; index < count; index += 1) {
          await ask("hello");
        }
      } else {
        await ask(line);
      }
      return "continue";
    } catch (error) {
      // JavaScript can throw any value, so handle both Error objects and other values.
      write(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return "error";
    }
  }

  return { execute };
}
