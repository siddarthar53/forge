import assert from "node:assert/strict";
import { test } from "node:test";
import { bye, hello } from "../src/greet.js";
test("hello", () => assert.equal(hello(), "hello"));
test("bye", () => assert.equal(bye(), "bye"));
