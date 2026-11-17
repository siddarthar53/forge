// A shopping cart: items are { name, price, quantity }.
export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  return Math.round(total * 100) / 100;
}

export function itemCount(items) {
  return items.reduce((n, item) => n + item.quantity, 0);
}
