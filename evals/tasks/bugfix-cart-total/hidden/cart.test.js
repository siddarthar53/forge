import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal, itemCount } from "../src/cart.js";

test("total multiplies price by quantity", () => {
  assert.equal(cartTotal([{ name: "pen", price: 1.5, quantity: 4 }, { name: "book", price: 10, quantity: 1 }]), 16);
});
test("empty cart", () => assert.equal(cartTotal([]), 0));
test("rounds to cents", () => assert.equal(cartTotal([{ name: "x", price: 0.1, quantity: 3 }]), 0.3));
test("item count unchanged", () => assert.equal(itemCount([{ price: 1, quantity: 2 }, { price: 1, quantity: 3 }]), 5));
