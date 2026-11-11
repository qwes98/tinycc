# tinycc

A CLI coding agent harness.

The current CLI uses a deterministic fake model for local development. The agent loop executes file-reading requests and returns tool results to the model until it produces a final response. Command execution is unsupported.

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

`stats` reports attempted model calls, including failed calls. `help`, `stats`, and unavailable commands do not call the model.
`fail` simulates a model connection failure, and `batch 3` sends `hello` to the model three times, sequentially. The session accepts another command after a failure.

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

Node.js strips type annotations to run TypeScript. Type checking runs separately through `npm run typecheck`. The test glob is quoted so Node expands it instead of the shell, which also matches test files in subdirectories.

`./tinycc --demo read` reads `fixtures/project.txt` and prints `tinycc fixture`, and `./tinycc --demo inspect` reads two fixture files and prints `Inspected two files`. Relative file paths resolve from the process working directory.
