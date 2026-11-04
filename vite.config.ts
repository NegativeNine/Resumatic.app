import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One build for the React app and the Worker. Select a Cloudflare environment
// at build time with CLOUDFLARE_ENV (for example CLOUDFLARE_ENV=staging).
//
// Workers AI only runs remotely, and remote bindings need a Cloudflare login,
// so local dev leaves them off unless REMOTE_BINDINGS=1 (npm run dev:remote).
export default defineConfig({
  plugins: [react(), cloudflare({ remoteBindings: process.env.REMOTE_BINDINGS === "1" })],
});
