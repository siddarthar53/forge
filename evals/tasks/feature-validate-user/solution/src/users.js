let nextId = 1;

export function createUser({ name, age }) {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("name must be a non-empty string");
  if (!Number.isInteger(age) || age < 0 || age > 150) throw new RangeError("age must be an integer from 0 to 150");
  return { id: nextId++, name, age };
}
