const ELEVATED = new Set(["owner", "superuser"]);
// A user is an admin when any of their roles is elevated.
export function hasElevatedRole(user) {
  return (user.roles ?? []).some((r) => ELEVATED.has(r));
}
export const isGuest = (user) => !user;
