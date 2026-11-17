import { fetchUser } from "./api.js";

export async function loadUsers(ids) {
  const users = [];
  for (const id of ids) {
    users.push(fetchUser(id));
  }
  return users;
}
