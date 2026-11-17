import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "../src/paginate.js";

const letters = ["a", "b", "c", "d", "e", "f", "g"];

test("first page", () => assert.deepEqual(paginate(letters, 1, 3).items, ["a", "b", "c"]));
test("second page", () => assert.deepEqual(paginate(letters, 2, 3).items, ["d", "e", "f"]));
test("last partial page", () => assert.deepEqual(paginate(letters, 3, 3).items, ["g"]));
test("total pages rounds up", () => assert.equal(paginate(letters, 1, 3).totalPages, 3));
test("exact fit", () => assert.equal(paginate(["a", "b"], 1, 2).totalPages, 1));
test("empty list", () => assert.equal(paginate([], 1, 5).totalPages, 0));
