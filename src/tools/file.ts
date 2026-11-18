import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../tools.ts";
import { ToolError } from "./result.ts";

/** Returns file arguments or throws before filesystem access if path is not a string. */
function parseFileArguments(input: unknown): { path: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("path" in input) ||
    typeof input.path !== "string"
  ) {
    throw new ToolError("Invalid tool arguments: expected { path: string }");
  }
  if (input.path.includes("\0")) {
    throw new ToolError(
      "Invalid tool arguments: path must not contain null bytes",
    );
  }
  return { path: input.path };
}

/**
 * Reads UTF-8 text. Relative paths start at the process working directory at call time.
 * Absolute paths stay absolute.
 * Resolves to unchanged contents. Expected path/permission failures reject with ToolError
 * for conversion to a failed tool result; unexpected host failures reject unchanged.
 */
async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(resolve(process.cwd(), path), "utf8");
  } catch (error) {
    // Only known filesystem failures become model input; programming/resource defects stay fatal.
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "EISDIR",
        "ENOTDIR",
        "ELOOP",
        "ENAMETOOLONG",
      ].includes(error.code)
    ) {
      throw new ToolError(error.message, { cause: error });
    }
    throw error;
  }
}

/** File argument validation, UTF-8 reading, and unchanged output formatting. */
export const fileToolDefinition = {
  parse: parseFileArguments,
  run: ({ path }) => readTextFile(path),
  format: (text) => text,
} satisfies ToolDefinition<{ path: string }, string>;
