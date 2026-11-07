#!/usr/bin/env node
// The live-evaluation process and the staging test Vault have separate
// budgets. Concurrency groups only serialize jobs; they cannot track spend or
// calls across runs. Keep both paid CI entry points closed until a durable,
// shared accounting mechanism enforces one authorization across them.
console.error("Paid CI is pending shared budget accounting across live evaluations and staging E2E; no model calls were made by this job.");
process.exitCode = 2;
