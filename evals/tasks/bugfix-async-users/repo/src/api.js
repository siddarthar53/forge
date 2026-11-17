// Pretend network call.
export async function fetchUser(id) {
  await new Promise((r) => setTimeout(r, 5));
  return { id, name: `user-${id}` };
}
