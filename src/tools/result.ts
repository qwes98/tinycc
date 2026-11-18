/**
 * A completed tool attempt. Content preserves the full success output or failure description.
 * isError tells the model whether the attempt failed; it does not request an automatic retry.
 * Unexpected internal failures reject instead of producing this result.
 */
export type ToolResult = { content: string; isError: boolean };

/**
 * An expected input or operational failure that a tool intentionally exposes to the model.
 * defineTool converts this exception from parse/run to a failed ToolResult.
 * Other exceptions, including formatting defects, remain fatal to the current request.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
