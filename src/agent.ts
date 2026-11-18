import type { Model, Message } from "./model.ts";
import { executeTool } from "./tools.ts";
import type { ToolCall } from "./tools.ts";

/** Progress only; final text is returned by runAgent instead of emitted again. */
export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: string }
  | { type: "tool_error"; call: ToolCall; error: string };

/** Synchronous observer. Must not mutate calls; thrown errors reject the request. */
export type OnEvent = (event: AgentEvent) => void;

/**
 * Runs one request with a fresh history until the model returns final text.
 * Record the user prompt first, then each assistant tool request and its unchanged result.
 * Tool calls run sequentially. Progress is reported synchronously in execution order.
 * Optional intermediate text precedes tool_start; tool_end preserves the complete result.
 * Expected failed results emit tool_error, enter history with isError, and return to the model.
 * Unexpected tool/model exceptions reject without a tool_error or another model call.
 * Observer failures reject without recording a result or continuing the request.
 * No turn limit is imposed; the model must eventually return text or reject.
 * @param prompt User input for this request; previous requests are not retained.
 * @param model Receives the complete ordered history on each call.
 * @param runTool Resolves to a success/expected failure outcome; unexpected host failures reject.
 * @param _onEvent Receives progress once per event; omitted observers discard progress.
 * @returns The model's final text, without trimming whitespace.
 */
export async function runAgent(
  prompt: string,
  model: Model,
  runTool: typeof executeTool = executeTool,
  _onEvent: OnEvent = () => {},
): Promise<string> {
  const history: Message[] = [{ role: "user", content: prompt }];
  let resp = await model(history);

  while (typeof resp !== "string") {
    if (resp.text) {
      _onEvent({ type: "assistant_text", text: resp.text });
    }
    _onEvent({ type: "tool_start", call: resp });
    history.push({ role: "assistant", content: resp });

    const toolResult = await runTool(resp);
    // Reporting never catches exceptions: a display defect must not become model input.
    if (toolResult.isError) {
      _onEvent({ type: "tool_error", call: resp, error: toolResult.content });
    } else {
      _onEvent({ type: "tool_end", call: resp, result: toolResult.content });
    }
    history.push({
      role: "tool",
      content: toolResult.content,
      isError: toolResult.isError,
    });
    resp = await model(history);
  }

  return resp;
}
