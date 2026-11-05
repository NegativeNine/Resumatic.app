// Secrets are set with `wrangler secret put` (and .dev.vars locally), so `wrangler types`
// cannot see them. They are declared here, on both the global Env and Cloudflare.Env
// (the type of `import { env } from "cloudflare:workers"`).
interface ResumaticSecrets {
  /** HMAC key for session and sign-in cookies. */
  SESSION_KEY: string;
  /** Google OAuth client secret. */
  OIDC_CLIENT_SECRET: string;
  /** Cloudflare API token with Workers AI Read, for the gateway's chat endpoint. */
  CF_AI_TOKEN: string;
  /** Staging only. Enables POST /auth/test-login. Never set in production. */
  TEST_SIGNIN_KEY?: string;
}

interface Env extends ResumaticSecrets {}

declare namespace Cloudflare {
  interface Env extends ResumaticSecrets {}
}
