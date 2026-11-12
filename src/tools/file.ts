import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../tools.ts";

/** Returns file arguments or throws before filesystem access if path is not a string. */
function parseFileArguments(input: unknown): { path: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("path" in input) ||
    typeof input.path !== "string"
  ) {
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

/** File argument validation, UTF-8 reading, and unchanged output formatting. */
export const fileToolDefinition = {
  parse: parseFileArguments,
  run: ({ path }) => readTextFile(path),
  format: (text) => text,
} satisfies ToolDefinition<{ path: string }, string>;
