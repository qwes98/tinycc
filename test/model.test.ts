import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel, type Message } from "../src/model.ts";

// The Node test runner reports failures; registration Promises are intentionally not awaited.

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
