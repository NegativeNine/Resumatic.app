# Recovering unbound Google shard claims

This is a design for review, not an implemented recovery procedure. An unbound
home can represent an abandoned claim, an account whose first bind was
interrupted, or a creation request that is still in flight. A missing identity
on one shard does not distinguish those cases. The current implementation
leaves an unbound claim pending; a fresh sign-in can bind a newly created
account only when its coordinator and shard claim tokens match.

Advancing the global OAuth epoch is not sufficient on its own. A request already
dispatched to a shard carries its old epoch, but the shard can still accept it
until its local floor advances. The regression in
`test/integration/unbound-claim-fence.test.ts` exercises that interval. An
empty scan, elapsed time, an expired OAuth state, or an epoch change alone must
not authorize releasing the claim.

## Candidate protocol

Any implementation needs an explicit migration and an independently reviewed
rollout plan before it can be used with real identities:

1. On the global Directory, atomically verify the claim token, shard, unbound
   owner and an open placement state; record a durable recovery generation;
   freeze that home against new claims and binds; and advance the global
   authorization epoch. Reject stale recovery requests by generation and
   token. The freeze and epoch advance must commit together.
2. Install SQLite guards that also reject old `INSERT OR IGNORE` claim and
   binding paths while a home is frozen. Review all versions that may still
   serve traffic: a guard applied to new RPC code alone is not enough, and a
   Durable Object running pre-migration code is not fenced by a future schema.
3. Acknowledge the new epoch floor on every shard that could contain an
   identity, not just the current claim's target. The target must atomically
   advance its floor and inspect the identity; retain each acknowledgement
   durably at the coordinator. Handle the global Directory's own identity in
   the freeze transaction. Failures, lost replies, malformed rows, and unknown
   prior locations leave the recovery pending. Establish that no older caller
   with a post-freeze authorization can bypass the frozen coordinator through
   an existing-identity path.
4. If any identity exists, preserve it and stop for reconciliation; do not
   delete career data merely because the original sign-in was interrupted.
   A matching claim token can support resuming a bind, but inconsistent tokens,
   duplicate identities, deleting accounts, and unknown owners need an
   explicit resolution. Recheck the home generation and owner at every
   transition and serialize with ordinary account deletion.
5. Only after the complete, verified set of locations has acknowledged its
   fence and absence may a conditional transaction release the same still
   unbound claim. A lost final reply needs an idempotent receipt that cannot
   authorize release of a later claim. Account for the privacy and retention of
   that receipt and of unfinished recovery metadata in the deletion audit.

The proposed floor advance invalidates outstanding Google sign-ins, including
unrelated ones; users would need to restart authorization. A recovery could
remain frozen indefinitely after a failed RPC. Operations need a resumable,
Access-protected workflow and diagnostics that do not log subjects, emails,
claim tokens, or career content.

## Evidence required before use

- Exercise delayed claim, target creation and bind calls from each supported
  Worker/Directory version, including calls that observed an existing identity
  before deletion. Confirm behavior across actual mixed-version deployment,
  Durable Object eviction, and migration ordering rather than assuming a drain.
- Inject failure or a lost acknowledgement at every transition and verify that
  recovery remains pending or resumes without deleting an account. Race
  recovery with sign-in, account deletion, configuration changes, and another
  recovery attempt.
- Verify all historical placement locations and older unfenced dispatches can
  be inventoried or quiesced. A new migration cannot retroactively account for
  a request that bypassed the protocol, and a scan is not evidence that such a
  request will never arrive.
- Audit recovery state, claim tokens, and receipts through account export and
  erasure, including legacy tokenless and already-orphaned identities. Define
  the retention and manual resolution policy before exposing an operator tool.

Until those conditions are met, this design does not establish automatic
cleanup, complete erasure, or safe production shard migration.
