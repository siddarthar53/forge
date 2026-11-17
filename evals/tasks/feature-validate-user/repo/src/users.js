let nextId = 1;

export function createUser({ name, age }) {
  return { id: nextId++, name, age };
}
