# Isolated synthetic pipeline smoke

This is a small live check of the production splitting, offer and tagging functions against the production Clef judge through the Workers API. It is separate from the shared staging pilot and does not enable or alter that pilot's identity or accounting guards. It sends fixed, invented lines only and accepts no resume or taxonomy input.

It permits at most **$1 in conservative reservations and 50 weighted upstream attempts**, with six weighted attempts reserved before each actual provider request. The fixed plan uses eight requests (48 weighted attempts):

- Three judge questions about an adversarial split with verb-object pairs swapped. The split proposal is predetermined; Muse generation is not tested.
- Two directions of an equivalent-wording match, as a positive control. A helped/led pair also passes through the offer function and must be stopped without a model call.
- Three questions about a single tool candidate: actual use, explicit denial and an intention. Only actual use may receive a tag.

The private, durable SQLite ledger is created exclusively and cannot be reset by rerunning the command. Reservations commit before dispatch; unknown usage or a failed request freezes the campaign. Questions run sequentially. A fresh adapter cannot reset the allowance. The report must contain eight settled attempts and positive results, so a judge declining everything cannot pass.

With a current Cloudflare token set as `CF_AI_TOKEN`, the account ID in `CF_ACCOUNT_ID` and `AI_GATEWAY_ID=resumatic-staging`, create an empty owner-only directory outside the checkout, then run:

```sh
node scripts/pipeline-smoke.mjs --live --directory /absolute/path/to/private-campaign
```

The directory receives `first-staging-evals-budget.sqlite` and `pipeline-smoke-report.json`. Both stay outside the checkout. Do not delete or recreate a campaign to retry; inspect its ledger and obtain a new budget if more calls are needed. Provider usage is priced with the repository's price table; these are local conservative accounting limits, not a provider-side spending guarantee.

Passing this smoke does not complete `split.eval.ts`, `match.eval.ts` or `tag.eval.ts`. It does not measure recall, real-resume quality, Muse proposals, vector candidates, the real taxonomy index, deployed Workflows or shared-pilot identity, and it does not authorize showing or enabling shadow proposals. The full synthetic suites and consented labelled evaluation remain outstanding.
