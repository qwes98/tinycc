# tinycc

A CLI coding agent harness.

The current CLI uses a deterministic fake model for local development. It can execute one file-reading request and display the result without making API requests. Command execution and the agent loop are unsupported.

## Run

Requires Node.js 24.12 or later.

```sh
npm install
./tinycc --demo hello
./tinycc --demo read
./tinycc
```

The demo prints `tinycc ready`. In an interactive session, try:

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
`fail` simulates a model connection failure. The session accepts another command afterward.
`batch 3` sends `hello` to the model three times, sequentially.

## Verify

```sh
npm run check
```

Node.js strips type annotations to run TypeScript. Type checking runs separately through `npm run typecheck`. The test glob is quoted so Node expands it instead of the shell, which also matches test files in subdirectories.

`./tinycc --demo read` reads `fixtures/project.txt` and prints `tinycc fixture`. Relative file paths resolve from the process working directory.