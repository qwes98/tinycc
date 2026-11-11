import { createInterface } from "node:readline";
import { fakeModel } from "./model.ts";
import { createSession } from "./session.ts";

// Reuse one session so all input lines share the same call counter.
// console.log supplies the newline; session messages do not need to include it.
const session = createSession(fakeModel, (text) => console.log(text));
// Node supplies the executable and script paths first; only the remaining items are CLI arguments.
const args = process.argv.slice(2);

if (args.length === 2 && args[0] === "--demo") {
  // Demo mode runs one command and reports a command failure through the process exit code.
  const outcome = await session.execute(args[1]!);
  if (outcome === "error") process.exitCode = 1;
} else if (args.length > 0) {
  console.error("Usage: ./tinycc or ./tinycc --demo hello");
  process.exitCode = 1;
} else {
  // Show prompts only when both streams are terminals, keeping piped output free of prompts.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    prompt: "tinycc> ",
  });
  if (interactive) {
    console.log("tinycc — fake model / type help for commands");
    input.prompt();
  }
  try {
    // Wait for each command to finish before handling the next line, including piped input.
    for await (const line of input) {
      const outcome = await session.execute(line);
      if (outcome === "exit") break;
      // An "error" outcome still allows another command in this input loop.
      if (interactive) input.prompt();
    }
  } finally {
    // Release the input interface on EOF, an exit request, or an unexpected exception.
    input.close();
  }
}
