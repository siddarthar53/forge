import { requireAdmin } from "../middleware/guard.js";
export function handle(path, req) {
  if (path.startsWith("/admin")) return requireAdmin(req) ? "admin page" : "403";
  return "home";
}
