# tinycc

A CLI coding agent harness.

The CLI supports the Anthropic Messages API and a deterministic fake model for local development. The agent loop executes tool requests and returns results to the model until it produces a final response. File reading and command execution are supported. Command outcomes are formatted as text for the model.

## Run

Requires Node.js 24.12 or later.

```sh
npm install
./tinycc --demo hello
./tinycc --demo read
./tinycc --demo inspect
./tinycc
```

The `hello` demo prints `tinycc ready`. In an interactive session, try:

```text
help
hello
stats
batch 3
stats
fail
hello
exit
```

`stats` reports attempted model calls, including failed calls. `help` and `stats` do not call the model.
`fail` simulates a model connection failure, and `batch 3` sends `hello` to the model three times, sequentially. The session accepts another command after a failure.

## Anthropic API

Copy `.env.example` to `.env` in the repository root and set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` to your API key and an available Claude model ID. Alternatively, export those variables in your shell. Exported values take precedence over `.env`. The CLI loads `.env` only in Anthropic mode. The default session and all `--demo` commands use the fake model without network access.

```sh
./tinycc --model anthropic
./tinycc --model anthropic --prompt "Read fixtures/project.txt and report its contents."
./tinycc --model anthropic --prompt 'Run node with arguments ["-e", "process.stdout.write(String(6 * 7))"] and report the result.'
```

Anthropic mode executes model-requested tools in the current working directory. Commands run immediately with your OS permissions, without approval prompts or a sandbox. Use a disposable working directory. Child processes omit `ANTHROPIC_*` environment variables; filesystem access, including access to `.env`, remains unrestricted.

Each input line starts an independent request history; only the model call counter persists across lines. In interactive and piped sessions, local commands such as `help`, `stats`, `batch`, and `exit` are handled by the CLI. `--prompt` sends one literal, nonempty request to the model, including text that matches a local command, and reports failures with a nonzero CLI exit code.

The adapter uses Node's built-in `fetch`, with a 60-second limit per API call and no automatic network retries. It requests at most one tool per response, with a 4,096 output-token limit per call. Reaching that token limit reports a `max_tokens` failure. The original assistant content and tool-use ID are preserved when returning a tool result. Incomplete generations and unsupported responses fail before a tool is executed. See Anthropic's [tool-call lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) and [parallel tool control](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).

The model is instructed to inspect affected state after command interruption before deciding what to retry. The host does not automatically roll back files, retry commands, or enforce that inspection. An API timeout also leaves prior tool side effects intact. Background command sessions, streaming, and descendant process management are not supported. The agent loop has no total call limit.

## Verify

```sh
npm run check
```

`check` verifies formatting, runs type-aware linting, checks types, and runs tests, in that order. It does not modify files and stops at the first failed command.

```sh
npm run format        # Format supported repository files with Prettier.
npm run format:check  # Check formatting without writing files.
npm run lint          # Run Oxlint, including Promise-handling rules.
npm run lint:fix      # Apply available safe lint fixes, then report remaining issues.
```

Prettier owns code formatting. Oxlint checks correctness, including unhandled Promises and Promises used where synchronous values are expected. Type-aware linting uses `oxlint-tsgolint`; it supplements the separate TypeScript check. Fixture contents are excluded from automatic formatting to preserve their exact text.

`npm install` (or `npm ci`) installs Git hooks through Husky. Before each commit, lint-staged applies safe Oxlint fixes to staged TypeScript files under `src/` and `test/`, then formats supported staged files with Prettier. Tasks run sequentially. When all tasks pass, their changes are staged automatically; if any task fails, lint-staged restores the original state and stops the commit. Unstaged edits in partially staged files are hidden during these tasks and restored afterward. Type-aware linting can still read unstaged edits in other files, so it does not validate an isolated commit snapshot. Inspect any errors and retry after resolving them. Run `npm run precommit` to run the same staged-file checks manually.

Before each push, `npm run check` validates the working tree without modifying files. Commit any intended changes before pushing so these checks cover the code you send. GitHub Actions also runs `npm ci` and `npm run check` on pushes and pull requests, without API credentials. Local hooks can be bypassed, so CI provides an independent check.

Node.js strips type annotations to run TypeScript. Type checking runs separately through `npm run typecheck`. The test glob is quoted so Node expands it instead of the shell, which also matches test files in subdirectories.

`src/tools.ts` defines the shared tool contract, registers built-in tools, and dispatches requests. Each module under `src/tools/` keeps one tool's argument parsing, execution, and result formatting together. Tests mirror these paths under `test/`.

`./tinycc --demo read` reads `fixtures/project.txt` and prints `tinycc fixture`, and `./tinycc --demo inspect` reads two fixture files and prints `Inspected two files`. Relative file paths resolve from the process working directory.

Command requests use `run_command` with `{ command: string, args: string[] }`. The runner starts the executable without a shell, passes arguments literally, inherits the current directory, and closes stdin. It captures UTF-8 stdout and stderr with a 10-second timeout and a 1 MiB limit per stream, using SIGKILL on limit violations. The runner resolves with a discriminated result: `exited`, `launch_error`, `timeout`, `output_limit`, or `signal`. Only `exited` has an `exitCode`. Outcomes preserve captured output so the model can decide its next action; output may be partial or truncated after interruption. Some work may already have happened before termination, so state must be checked before retrying. Invalid host inputs and unexpected internal errors still reject the request. The formatter describes each outcome and appends captured output to failure messages. These limits apply to the direct process; descendant process management is not supported. The command demos use the current Node executable and require no external utilities.
