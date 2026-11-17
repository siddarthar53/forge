import { hasElevatedRole } from "../auth/roles.js";
export const requireAdmin = (req) => Boolean(req.user) && hasElevatedRole(req.user);
