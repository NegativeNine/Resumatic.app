# Recovering uncertain initialization and Workflow creation

This is a proposed design and verification plan. It does not authorize clearing the current durable fences or demonstrate completed deletion. The present implementation deliberately leaves an unknown initialization or Workflow creation pending, and some migrations conservatively retain historical markers.

## Why a timeout is not enough

A caller can lose the acknowledgement for a request that has already executed or that may still arrive. Cloudflare documents no hard wall-time limit for an incoming Durable Object RPC. Pending I/O can keep an object alive for up to 15 minutes, but the operation is not documented to be cancelled when that keep-alive interval ends. A Workflow ID is unique while its instance exists within retention; completed-instance retention is bounded, and explicit deletion removes the instance. Neither a single not-found probe nor waiting for retention proves that an uncertain create cannot arrive later. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) and [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/).

A signed expiry timestamp could bound new requests only with a documented clock-accuracy and cross-incarnation monotonicity guarantee, plus enforcement by every destination version. Cloudflare states that `Date.now()` reflects the last I/O rather than advancing during execution; the documentation reviewed does not state a maximum cross-location skew or a monotonicity guarantee across an eviction. Do not clear a fence merely because a timer has elapsed. See [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/).

## Candidate: incarnation-bound Vault initialization

This protocol can be explored for **new Vaults** without assuming clock synchronization. It would not settle uncertain Workflow creations.

1. Each Vault incarnation creates an unpredictable, memory-only initialization epoch in its constructor. A new `issueInitChallenge()` RPC returns that epoch only if the object is neither closing nor destroyed. Reinitialization or hibernation creates a different epoch. This is a freshness value, not authentication: access to the Durable Object binding remains restricted to the Worker.
2. Directory records an epoch-protocol attempt before calling `issueInitChallenge`. After that awaited RPC returns, Directory rechecks, from its own durable state, that the exact user, Vault ID and operation are still active or preparing. Without another `await`, it dispatches `init(userId, epoch)`.
3. Vault rejects missing or incorrect epochs and closing/destroyed state **before any schema or metadata write**. The epoch check and all initialization writes run synchronously without an intervening `await`.
4. `destroy()` marks the instance closing and rotates its epoch synchronously before its first await, then performs the existing alarm and storage deletion. A delayed init from the old incarnation must fail both while deletion is in progress and after the object wakes with a new epoch.
5. A delayed challenge response received after account deletion must fail Directory's state recheck and must not cause another init. An evicted or restarted Directory must not dispatch based on an unverified cached account state.

With these conditions, new epoch-protocol attempts could have a separate marker from the existing legacy initialization fence. Deletion could invalidate those attempts without waiting for their acknowledgement. An unknown legacy `init(userId)` is different: old code accepts a call without an epoch, so its existing marker must remain blocking. Do not relabel or clear historical sticky markers based on a later successful attempt.

### Required rollout proof

The protocol is unsafe if a request can reach Vault code that accepts the old unversioned method after its epoch marker is treated as recoverable. Cloudflare documents [version skew in gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) and describes [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) as deployment-dependent. Before enabling recovery, obtain a provider-backed way to establish that all calls for the relevant namespace are handled by epoch-enforcing code, including already dispatched calls, and prevent a rollback to code that accepts unversioned init while such accounts or requests exist. Merely observing the new RPC once, deploying at 100%, or waiting five minutes is not evidence of this property. Keep mixed-version and pre-upgrade attempts on the legacy fence until a defensible migration and reconciliation exists.

Cloudflare's [Durable Object lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) describes global object uniqueness, in-flight requests and restarts. Validate the exact interaction among synchronous initialization, storage output gates, `deleteAll`, restarts, and version changes with the provider and deployed race tests; local workerd tests alone do not establish it.

## Workflow inventory remains a separate problem

An initialization epoch cannot prevent an already dispatched `Workflow.create()` from creating a later Workflow instance. That instance's current parameters contain Vault and run IDs, so an account-linked platform record may remain after an apparently empty sweep. A Workflow claim guard can prevent it from reading the closed Vault, but cannot prove that no linked instance, event or log exists.

A possible redesign is to pass a random opaque run capability instead of Vault and source IDs, resolve it through a strongly consistent, revocable mapping, and delete the mapping during erasure. Before treating an orphan instance as unlinked, verify the mapping lifecycle, the information in platform and gateway logs, delayed resolution races, and whether retained capabilities remain linkable to a user. This changes the data model and does not by itself satisfy the current all-store deletion audit. The existing audit must stay pending without independent complete inventory and retention evidence.

## Required tests before changing the fences

- Hold `init` before delivery, close and destroy the Vault, evict it, then deliver the old epoch: no schema or owner may be recreated. Repeat when destroy has started but its storage await has not completed.
- Hold `issueInitChallenge`, delete the account or retire a replacement, then release the response: Directory must not dispatch init or return an active session. Repeat after Directory eviction and after an identity is recreated with a different Vault ID.
- Exercise two concurrent sign-ins, lost challenge and init acknowledgements, failed init, retry with a fresh incarnation, cutover/deletion races, and legitimate ownership mismatch. An unavailable response must not turn an old marker into an epoch marker.
- Simulate old and new Directory/Vault versions in both directions, including rollback, delayed old `init(userId)`, a historical active Vault, a preparing replacement and a retired Vault. Every legacy or ambiguous case must remain fenced.
- Check transaction rollback and crashes at challenge return, state recheck, init dispatch, schema creation, close, alarm deletion, storage deletion and Directory checkpoint. No career content, credentials or user ID may be placed in a new tombstone or log.
- Run the full local suite and deployed end-to-end race tests. Independently audit Workflow, R2, OAuth, billing, gateway, Analytics Engine, recovery-history and fleet state before changing release or erasure status.
