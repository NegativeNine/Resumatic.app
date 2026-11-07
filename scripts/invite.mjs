#!/usr/bin/env node
import { httpsOrigin } from "./lib/config.mjs";

try {
  const base = httpsOrigin(process.env.APP_ORIGIN);
  const email = process.argv[2];
  const id = process.env.ACCESS_CLIENT_ID;
  const secret = process.env.ACCESS_CLIENT_SECRET;
  if (
    !base ||
    !id ||
    !secret ||
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    throw new Error(
      "Set APP_ORIGIN, ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET, and pass one email address.",
    );
  const response = await fetch(`${base}/admin/invites`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": id,
      "CF-Access-Client-Secret": secret,
    },
    body: JSON.stringify({ email }),
  });
  if (!response.ok)
    throw new Error(
      `Invite failed (HTTP ${response.status}); verify Access service-token policy.`,
    );
  console.log("Invite created. No email was sent.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invite failed.");
  process.exitCode = 1;
}
