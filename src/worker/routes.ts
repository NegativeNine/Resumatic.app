import { Hono, type Context } from "hono";

// The only HTTP surface. /auth/* and /admin/* may call the Directory;
// /api/* routes go straight to the caller's vault and never touch it.
export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Filled in by later milestones; see docs/v1-codebase-plan.md.
const notYet = (c: Context) => c.json({ error: "not_implemented" }, 501);
app.all("/api/*", notYet);
app.all("/auth/*", notYet);
app.all("/admin/*", notYet);
