// Secrets are set with `wrangler secret put` (and .dev.vars locally), so `wrangler types`
// cannot see them. They are declared here, on both the global Env and Cloudflare.Env
// (the type of `import { env } from "cloudflare:workers"`).
interface ResumaticSecrets {
  /** HMAC key for session and sign-in cookies. */
  SESSION_KEY: string;
  EXTRACTOR?: string;
  EXTRACTOR_EXPERIMENT?: string;
  EXTRACTOR_BY_FORMAT?: string;
  BILLING_ENABLED?: string;
  BILLING_PLANS_JSON?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_VERSION?: string;
  APP_ORIGIN?: string;
  DAILY_SPEND_CAP_USD?: string;
  MODEL_PRICES_JSON?: string;
  MODEL_MAX_CALL_USD?: string;
  MODEL_TRANSCRIBE?: string;
  /** Disabled until all readers/writers and rollout safety are verified. */
  ROLE_UNKNOWN_END_ENABLED?: string;
  MCP_ENABLED?: string;
  MCP_ALLOWED_ORIGINS?: string;
  OAUTH_KV?: KVNamespace;
  METRICS?: AnalyticsEngineDataset;
  AUTH_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  WRITE_LIMIT?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  ALERTS_ENABLED?: string;
  ALERT_WEBHOOK_URL?: string;
  CF_ANALYTICS_TOKEN?: string;
  METRICS_DATASET?: string;
  ALERT_SPEND_USD_PER_15M?: string;
  ALERT_FAILURE_RATE?: string;
  ALERT_HTTP_5XX_RATE?: string;
  ALERT_MIN_ATTEMPTS?: string;
  RESTORE_FENCE_IDS?: string;
  /** Experimental; opt in only after reviewing unresolved-write recovery. */
  R2_CACHE_FENCE_ENABLED?: string;
  /** Experimental; placement migration and legacy recovery remain unverified. */
  PLACEMENT_FENCE_ENABLED?: string;
  RATE_LIMITS_ENABLED?: string;
  DIRECTORY_SHARDS?: string;
  RETENTION_REVIEW_ID?: string;
  EMBEDDING_MODEL?: string;

  /** Google OAuth client secret. */
  OIDC_CLIENT_SECRET: string;
  /** Cloudflare API token with Workers AI Read, for the gateway's chat endpoint. */
  CF_AI_TOKEN: string;
  /** Staging only. Enables POST /auth/test-login. Never set in production. */
  TEST_SIGNIN_KEY?: string;
  ALLOW_TEST_SIGNIN?: string;
  /** Separate staging-only secret and binding for the one-shot pilot ledger. */
  PILOT_BUDGET_KEY?: string;
  PILOT_BUDGET?: DurableObjectNamespace<import("./worker/pilot/object").PilotBudget>;
  /** Worker version under observation; configured only for staging probes. */
  PILOT_VERSION_METADATA?: WorkerVersionMetadata;
  /** Staging-wide opt-in; no request or user can choose a different mode. */
  PILOT_SHARED_BUDGET?: string;
}

interface Env extends ResumaticSecrets {}

declare namespace Cloudflare {
  interface Env extends ResumaticSecrets {}
}
