import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createAnthropicModel } from "./anthropic.ts";
import { fakeModel } from "./model.ts";
import { createSession } from "./session.ts";
import { formatProgress } from "./progress.ts";

/**
 * Runs one prompt or sequential input lines; resolves after EOF, exit, or a one-shot reply.
 * Configuration and unexpected failures reject to the entry point for exit-code reporting.
 * Anthropic mode loads the repository's optional .env; exported environment values take precedence.
 * Demo mode and the default session always use the fake model without loading credentials.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.length === 2 && args[0] === "--demo";
  const anthropic = args[0] === "--model" && args[1] === "anthropic";
  const oneShot = anthropic && args.length === 4 && args[2] === "--prompt";
  if (!(
    args.length === 0 ||
    demo ||
    (anthropic && (args.length === 2 || oneShot))
  )) {
    throw new Error(
      'Usage: ./tinycc [--demo <command> | --model anthropic [--prompt "<request>"]]',
    );
  }
  if (anthropic) {
    try {
      process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
    } catch (error) {
      // A missing file is fine when credentials are exported by the parent shell.
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  const model = anthropic
    ? createAnthropicModel({
        apiKey: process.env.ANTHROPIC_API_KEY ?? "",
        model: process.env.ANTHROPIC_MODEL ?? "",
      })
    : fakeModel;
  // Reuse one session so all input lines share the same call counter.
  // console.log supplies the newline; session messages do not need to include it.
  // Progress goes to stderr in both terminal and pipe mode; stdout keeps final replies.
  const session = createSession(
    model,
    (text) => console.log(text),
    (event) => console.error(formatProgress(event)),
  );
  if (oneShot) {
    // A one-shot prompt is user text, even when it matches a local command such as exit.
    await session.ask(args[3]!);
    return;
  }
  if (demo) {
    const outcome = await session.execute(args[1]!);
    if (outcome === "error") process.exitCode = 1;
    return;
  }
  // Show prompts only when both streams are terminals, keeping piped output free of prompts.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    prompt: "tinycc> ",
  });
  if (interactive) {
    console.log(
      `tinycc — ${anthropic ? "Anthropic" : "fake model"} / type help for commands`,
    );
    input.prompt();
  }
  try {
    // Wait for each command to finish before handling the next line, including piped input.
    for await (const line of input) {
      const outcome = await session.execute(line);
      if (outcome === "exit") break;
      if (interactive) input.prompt();
    }
  } finally {
    input.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
