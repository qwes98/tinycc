import type { Model, Message } from "./model.ts";
import { executeTool } from "./tools.ts";

/**
 * Runs one request with a fresh history until the model returns final text.
 * Record the user prompt first, then each assistant tool request and its unchanged result.
 * Tool calls run sequentially. Only final text is returned; intermediate output is not displayed.
 * Model and tool failures reject immediately, leaving reporting to the caller.
 * No turn limit is imposed; the model must eventually return text or reject.
 * @param prompt User input for this request; previous requests are not retained.
 * @param model Receives the complete ordered history on each call.
 * @param runTool Executes a request and resolves to unmodified tool output, or rejects.
 * @returns The model's final text, without trimming whitespace.
 */
export async function runAgent(
  prompt: string,
  model: Model,
  runTool: typeof executeTool = executeTool,
): Promise<string> {
  const history: Message[] = [{ role: "user", content: prompt }];
  let resp = await model(history);

  while (typeof resp !== "string") {
    history.push({ role: "assistant", content: resp });
    const toolResult = await runTool(resp);
    history.push({ role: "tool", content: toolResult });
    resp = await model(history);
  }

  return resp;
}
