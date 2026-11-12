import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel, type Message } from "../src/model.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

void test("command replies use the supplied tool result", async () => {
  for (const prompt of ["command", "command-error"]) {
    const messages: Message[] = [{ role: "user", content: prompt }];
    const request = await fakeModel(messages);
    assert.ok(typeof request !== "string");
    assert.equal(request.name, "run_command");
    assert.deepEqual(request.arguments, {
      command: process.execPath,
      args: [
        "-e",
        prompt === "command"
          ? 'process.stdout.write("42\\n")'
          : "process.exit(7)",
      ],
    });
    messages.push(
      { role: "assistant", content: request },
      { role: "tool", content: "Supplied result\n" },
    );
    assert.equal(await fakeModel(messages), "Supplied result\n");
  }
});

void test("the fake model requests files and uses the returned text", async () => {
  for (const prompt of ["read", "inspect"]) {
    const messages: Message[] = [{ role: "user", content: prompt }];
    const first = await fakeModel(messages);
    assert.deepEqual(first, {
      type: "tool_call",
      name: "read_file",
      arguments: { path: "fixtures/project.txt" },
    });
    assert.ok(typeof first !== "string");
    messages.push(
      { role: "assistant", content: first },
      { role: "tool", content: "Actual file text\n" },
    );
    if (prompt === "read") {
      assert.equal(await fakeModel(messages), "Actual file text\n");
    } else {
      const second = await fakeModel(messages);
      assert.deepEqual(second, {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "fixtures/notes.txt" },
      });
      assert.ok(typeof second !== "string");
      messages.push(
        { role: "assistant", content: second },
        { role: "tool", content: "Notes\n" },
      );
      assert.equal(await fakeModel(messages), "Inspected two files");
    }
  }
});
