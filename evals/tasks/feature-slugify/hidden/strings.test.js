import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalize, slugify } from "../src/strings.js";

test("example", () => assert.equal(slugify("  Hello, World! 2026 "), "hello-world-2026"));
test("collapses separators", () => assert.equal(slugify("a -- b__c"), "a-b-c"));
test("trims hyphens", () => assert.equal(slugify("--Rock & Roll--"), "rock-roll"));
test("empty", () => assert.equal(slugify("!!!"), ""));
test("capitalize still works", () => assert.equal(capitalize("ada"), "Ada"));
