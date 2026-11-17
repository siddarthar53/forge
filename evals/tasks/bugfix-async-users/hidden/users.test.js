import assert from "node:assert/strict";
import { test } from "node:test";
import { loadUsers } from "../src/users.js";

test("resolves to user objects in order", async () => {
  assert.deepEqual(await loadUsers([3, 1]), [{ id: 3, name: "user-3" }, { id: 1, name: "user-1" }]);
});
test("empty list", async () => assert.deepEqual(await loadUsers([]), []));
