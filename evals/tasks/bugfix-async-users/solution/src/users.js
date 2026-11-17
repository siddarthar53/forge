import { fetchUser } from "./api.js";

export async function loadUsers(ids) {
  const users = [];
  for (const id of ids) {
    users.push(await fetchUser(id));
  }
  return users;
}
