import { handle } from "./routes/index.js";
export const start = () => handle("/admin", { user: { roles: ["staff"] } });
