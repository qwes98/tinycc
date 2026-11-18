import { fileToolDefinition } from "./tools/file.ts";
import { commandToolDefinition } from "./tools/command.ts";
import { ToolError, type ToolResult } from "./tools/result.ts";

export type { ToolResult } from "./tools/result.ts";

/** Keeps each tool's validated arguments and result connected inside defineTool. */
export type ToolDefinition<Args, Result> = {
  /** Validates external input; throw ToolError for model-correctable input before execution. */
  parse: (input: unknown) => Args;
  /** Resolves to a completed outcome, or rejects with ToolError for an expected failure. */
  run: (args: Args) => Promise<Result>;
  /** Converts a completed outcome to text without trimming; defects reject the request. */
  format: (result: Result) => string;
  /** Marks completed failure outcomes, such as nonzero exits. Omission means success. */
  isError?: (result: Result) => boolean;
};

/** Common registry interface; argument and result types stay inside each tool. */
export type Tool = {
  /** Resolves to success/expected failure; unexpected exceptions reject to the caller. */
  execute: (input: unknown) => Promise<ToolResult>;
};

export type ToolRegistry = Readonly<Record<string, Tool>>;

/**
 * Wraps one definition as a registry entry without losing type checks between its stages.
 * Each call validates first, runs once, then formats its completed outcome.
 * ToolError from validation/execution becomes a failed result for the model to act on.
 * Unexpected exceptions and formatting/classification defects reject without automatic retries.
 */
export function defineTool<Args, Result>(
  definition: ToolDefinition<Args, Result>,
): Tool {
  return {
    async execute(input) {
      let result: Result;
      try {
        const args = definition.parse(input);
        result = await definition.run(args);
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return { content: error.message, isError: true };
      }
      // Formatting and classification are host code, so their defects must stay visible.
      return {
        content: definition.format(result),
        isError: definition.isError?.(result) ?? false,
      };
    },
  };
}

/** Accepts JSON objects, excluding null and arrays, for property validation. */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// Concrete tools import only ToolDefinition as a type; runtime assembly stays here.
const defaultTools = {
  read_file: defineTool(fileToolDefinition),
  run_command: defineTool(commandToolDefinition),
} satisfies ToolRegistry;

/**
 * A model request. Names and arguments remain untrusted until registry dispatch and parsing.
 * An unknown name produces an error result so the model can select an advertised tool.
 */
export type ToolCall = {
  type: "tool_call";
  name: string;
  arguments: unknown;
};

/** Built-in names advertised to models; derived from the executable registry. */
export type ToolName = keyof typeof defaultTools;

/**
 * Validates a parsed external request and resolves to a structured tool outcome.
 * The selected tool validates its arguments before running; this function does not parse JSON.
 * Invalid requests and unknown names resolve with isError so the caller can return them to the model.
 * Unexpected tool exceptions reject. Injected registries can replace or add tools without filesystem access.
 */
export async function executeTool(
  call: unknown,
  tools: ToolRegistry = defaultTools,
): Promise<ToolResult> {
  if (
    !isRecord(call) ||
    call.type !== "tool_call" ||
    typeof call.name !== "string" ||
    !Object.hasOwn(call, "arguments")
  ) {
    return {
      content:
        "Invalid tool call: expected { type: 'tool_call', name: string, arguments }",
      isError: true,
    };
  }
  // Prototype properties such as toString are not registered tools.
  if (!Object.hasOwn(tools, call.name)) {
    return { content: `Unknown tool: ${call.name}`, isError: true };
  }
  return tools[call.name].execute(call.arguments);
}
