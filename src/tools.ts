import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Keeps each tool's validated arguments and result connected inside defineTool. */
export type ToolDefinition<Args, Result> = {
  /** Validates external input, returning typed arguments or throwing before execution. */
  parse: (input: unknown) => Args;
  /** Resolves to the tool's result; execution failures reject the promise. */
  run: (args: Args) => Promise<Result>;
  /** Converts a successful result to the text returned to the caller. */
  format: (result: Result) => string;
};

/** Common registry interface; argument and result types stay inside each tool. */
export type Tool = {
  /** Resolves to formatted text; validation, execution, and formatting failures reject. */
  execute: (input: unknown) => Promise<string>;
};

export type ToolRegistry = Readonly<Record<string, Tool>>;

/**
 * Wraps one definition as a registry entry without losing type checks between its stages.
 * Each call validates first, runs once, then formats only a successful result.
 * Failures propagate as promise rejections for the caller to report.
 */
export function defineTool<Args, Result>(definition: ToolDefinition<Args, Result>): Tool {
  return {
    async execute(input) {
      const args = definition.parse(input);
      const result = await definition.run(args);
      return definition.format(result);
    },
  };
}

/** Accepts JSON objects, excluding null and arrays, for property validation. */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Returns file arguments or throws before filesystem access if path is not a string. */
function parseFileArguments(input: unknown): { path: string } {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("Invalid tool arguments: expected { path: string }");
  }
  return { path: input.path };
}

/**
 * Reads UTF-8 text. Relative paths start at the process working directory at call time.
 * Absolute paths stay absolute.
 * Resolves to the unchanged file contents; filesystem errors reject the promise.
 */
async function readTextFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

const defaultTools = {
  read_file: defineTool({
    parse: parseFileArguments,
    run: ({ path }) => readTextFile(path),
    format: (text) => text,
  }),
} satisfies ToolRegistry;

/**
 * A model request for a built-in tool. Names follow the registry automatically.
 * Arguments remain untrusted until the selected tool validates them at runtime.
 */
export type ToolCall = {
  type: "tool_call";
  name: keyof typeof defaultTools;
  arguments: unknown;
};

/**
 * Validates a parsed external request, selects an own registry entry, and resolves to text.
 * The selected tool validates its arguments before running; this function does not parse JSON.
 * Unknown names reject with Error("Unknown tool: <name>"); all other failures also propagate.
 * Callers report failures. Injected registries can replace or add tools without filesystem access.
 */
export async function executeTool(
  call: unknown,
  tools: ToolRegistry = defaultTools,
): Promise<string> {
  if (!isRecord(call) || call.type !== "tool_call" || typeof call.name !== "string"
    || !Object.hasOwn(call, "arguments")) {
    throw new Error("Invalid tool call: expected { type: 'tool_call', name: string, arguments }");
  }
  // Prototype properties such as toString are not registered tools.
  if (!Object.hasOwn(tools, call.name)) {
    throw new Error(`Unknown tool: ${call.name}`);
  }
  return tools[call.name].execute(call.arguments);
}
