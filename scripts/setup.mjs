#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readConfig } from "./lib/config.mjs";

const [environment, ...flags] = process.argv.slice(2);
try {
  if (flags.some((f) => !["--apply", "--secrets"].includes(f)))
    throw new Error("unsupported option");
  if (flags.includes("--secrets") && !flags.includes("--apply"))
    throw new Error("--secrets requires --apply");
  const { config, name } = await readConfig(environment);
  const bucket = config.r2_buckets?.find(
    (b) => b.binding === "FILES",
  )?.bucket_name;
  const gateway = config.vars?.AI_GATEWAY_ID;
  const oauthNamespace = `${name}-oauth`;
  const provisionOauth =
    config.kv_namespaces?.some(
      (namespace) => namespace.binding === "OAUTH_KV",
    ) ?? false;
  if (!/^[a-z0-9-]+$/.test(bucket ?? "") || !/^[a-z0-9-]+$/.test(gateway ?? ""))
    throw new Error("invalid resource names");
  console.log(
    JSON.stringify({
      environment,
      worker: name,
      bucket,
      gateway,
      ...(provisionOauth ? { oauthNamespace } : {}),
      authentication: true,
      gatewayPayloadLogging: false,
      caching: false,
      apply: flags.includes("--apply"),
    }),
  );
  if (!flags.includes("--apply")) {
    console.log(
      "Plan only. Use --apply to create missing resources; add --secrets to enter Worker secrets interactively.",
    );
  } else {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!/^[a-f0-9]{32}$/i.test(account ?? "") || !token)
      throw new Error("Cloudflare credentials are missing");
    if (config.vars.CF_ACCOUNT_ID && config.vars.CF_ACCOUNT_ID !== account)
      throw new Error("configured account differs from deployment account");
    async function api(path, method = "GET", body) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (method === "GET" && response.status === 404) return null;
      if (!response.ok)
        throw new Error(`Cloudflare operation failed (${response.status})`);
      const result = await response.json();
      if (!result.success)
        throw new Error("Cloudflare operation was not successful");
      return result.result;
    }
    if (!(await api(`/r2/buckets/${bucket}`)))
      await api("/r2/buckets", "POST", { name: bucket });
    const current = await api(`/ai-gateway/gateways/${gateway}`);
    // Disable gateway logging until a deployed metadata-only smoke check verifies request controls.
    const settings = {
      id: gateway,
      authentication: true,
      collect_logs: false,
      cache_ttl: 0,
      cache_invalidate_on_update: true,
      rate_limiting_interval: current?.rate_limiting_interval ?? 0,
      rate_limiting_limit: current?.rate_limiting_limit ?? 0,
    };
    if (!current) await api("/ai-gateway/gateways", "POST", settings);
    else await api(`/ai-gateway/gateways/${gateway}`, "PUT", settings);
    if (provisionOauth) {
      const matches = [];
      for (let page = 1; ; page++) {
        const namespaces = await api(
          `/storage/kv/namespaces?page=${page}&per_page=100`,
        );
        if (!Array.isArray(namespaces))
          throw new Error("unexpected namespace response");
        matches.push(
          ...namespaces.filter(
            (namespace) => namespace.title === oauthNamespace,
          ),
        );
        if (namespaces.length < 100) break;
      }
      if (matches.length > 1)
        throw new Error(
          "multiple OAuth namespaces have the planned title; resolve them before deployment",
        );
      const namespace =
        matches[0] ??
        (await api("/storage/kv/namespaces", "POST", {
          title: oauthNamespace,
        }));
      console.log(
        JSON.stringify({
          instruction:
            "Set the OAUTH_KV binding id in the selected environment",
          id: namespace.id,
          title: oauthNamespace,
        }),
      );
    }
    console.log(
      "Resources provisioned. Verify Logpush does not export bodies before running models.",
    );
    if (flags.includes("--secrets")) {
      if (!process.stdin.isTTY)
        throw new Error("secret entry requires an interactive terminal");
      const secrets = [
        "SESSION_KEY",
        "OIDC_CLIENT_SECRET",
        "CF_AI_TOKEN",
        ...(environment === "staging" ? ["TEST_SIGNIN_KEY"] : []),
      ];
      for (const secret of secrets) {
        const args = [
          "wrangler",
          "secret",
          "put",
          secret,
          ...(environment === "staging" ? ["--env", "staging"] : []),
        ];
        const result = spawnSync("npx", args, { stdio: "inherit" });
        if (result.status !== 0)
          throw new Error(`secret setup failed for ${secret}`);
      }
    }
  }
  console.log(
    "GitHub environment secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_AI_TOKEN; staging also needs TEST_SIGNIN_KEY. Live jobs additionally require explicit budget variables.",
  );
  if (config.vars?.MODEL_TRANSCRIBE)
    console.log(
      "Image transcription is pending until the operator accepts the configured model's license and runs the budgeted live image check. Setup does not accept model terms.",
    );
} catch (error) {
  console.error(
    `Setup failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
