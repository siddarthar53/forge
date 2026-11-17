import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "../src/paginate.js";

const letters = ["a", "b", "c", "d", "e", "f", "g"];

test("first page", () => assert.deepEqual(paginate(letters, 1, 3).items, ["a", "b", "c"]));
test("last partial page", () => assert.deepEqual(paginate(letters, 3, 3).items, ["g"]));
test("total pages rounds up", () => assert.equal(paginate(letters, 1, 3).totalPages, 3));
