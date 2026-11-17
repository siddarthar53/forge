import assert from "node:assert/strict";
import { test } from "node:test";
import { createUser } from "../src/users.js";

test("valid user", () => {
  const u = createUser({ name: "Ada", age: 36 });
  assert.equal(u.name, "Ada");
  assert.equal(u.age, 36);
  assert.equal(typeof u.id, "number");
});
test("bad name", () => {
  assert.throws(() => createUser({ name: "", age: 3 }), (e) => e instanceof TypeError && /name/i.test(e.message));
  assert.throws(() => createUser({ name: 42, age: 3 }), (e) => e instanceof TypeError && /name/i.test(e.message));
});
test("bad age", () => {
  for (const age of [-1, 151, 2.5, "30", undefined]) {
    assert.throws(() => createUser({ name: "Ada", age }), (e) => e instanceof RangeError && /age/i.test(e.message), String(age));
  }
});
test("edges", () => {
  createUser({ name: "A", age: 0 });
  createUser({ name: "B", age: 150 });
});
