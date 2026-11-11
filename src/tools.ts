import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** A model request to read a file at the given path. */
export type ToolCall = {
  type: "tool_call";
  name: "read_file";
  arguments: { path: string };
};

export type ToolHandlers = {
  read_file: (path: string) => Promise<string>;
};

/**
 * Reads UTF-8 text. Relative paths start at the process working directory at call time.
 * Absolute paths stay absolute.
 * Resolves to the unchanged file contents; filesystem errors reject the promise.
 */
async function readTextFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

const defaultTools: ToolHandlers = { read_file: readTextFile };

/**
 * Dispatches read_file using call.arguments.path and resolves to its unchanged result.
 * Unsupported names must reject with Error("Unknown tool: <name>").
 * Handler failures propagate to the caller, which is responsible for reporting them.
 * Injected handlers allow dispatch checks without filesystem access.
 */
export async function executeTool(
  call: ToolCall,
  tools: ToolHandlers = defaultTools,
): Promise<string> {
  if (!Object.keys(tools).includes(call.name)) {
    throw new Error(`Unknown tool: ${call.name}`);
  }
  const tool = tools[call.name];
  return tool(call.arguments.path);
}
