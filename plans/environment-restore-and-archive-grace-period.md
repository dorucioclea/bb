# Environment restore + archive grace period

Status: Phases 1–4 implemented 2026-06-17. (T3 checkpointing remains out of scope —
see verdict below.)

**Confirm dialog decision:** the planned Restore confirm modal was dropped. Restore
is non-destructive — by the time the environment is `destroyed`, uncommitted work is
already gone, so a "you'll lose work" modal would misattribute the loss. Restore is a
direct one-click action like Unarchive (the toast/banner copy carries expectations).

**Decision (2026-06-17):** short **10-second** grace window, surfaced as an **"Undo"
in the archive toast** — the immediate-misclick catch. After it, the worktree is
destroyed and **Restore** (reprovision from the branch) is the recovery path. The
grace window is deliberately *not* a "come back later and unarchive to get
uncommitted work" window; its only job is the 10s lossless undo.

## Problem

Two related gaps around a thread losing its environment:

1. **No "Restore environment" action.** When a thread's environment is
   `destroying`/`destroyed`, the prompt banner shows a dead-end read-only row
   ("Environment is no longer available") with no way forward. The thread is
   bricked.
2. **Accidental archive instantly bricks a thread.** Archiving the *last* live
   thread in a managed environment immediately tears down its git worktree, with
   no undo and no grace period. A misclick destroys uncommitted work.

This plan fixes the brick with a durable **grace period** (the cheap, high-value
win that makes accidental archive losslessly reversible), adds a **Restore
environment** action for the genuinely-gone case, and records a verdict on
whether T3's per-turn git-checkpoint scheme is relevant here (it is not, for this
change — see [T3 checkpointing](#t3-checkpointing-evaluation)).

## Current behavior (verified in code)

### Environment lifecycle is an event-sourced state machine

`packages/domain/src/environment-lifecycle.ts` defines `ENVIRONMENT_LIFECYCLE`
(statuses × events → next status). Relevant transitions:

- `ready` —`retire.requested`→ `retiring`
- `retiring` —`retire.cancelled`→ `ready`  ← **an undo edge already exists**
- `retiring` —`destroy.started`→ `destroying` (stamps `destroyAttemptId`)
- `destroying` —`destroy.completed`→ `destroyed` (terminal)
- `destroyed`: `{}` — **terminal**. Doc comment: *"a thread that needs an
  environment again gets a fresh record, it never resurrects the destroyed row
  (future 'Provision environment')."*

The durable state is the row's `(status, destroyAttemptId, updatedAt)`
(`packages/db/src/data/environments.ts`); there is no separate event log, but
`applyEnvironmentLifecycleEventRecord` (environments.ts:380) **stamps
`updatedAt` on every transition**, and the only legal exits from `retiring` are
`retire.cancelled` and `destroy.started`. So a `retiring` row's `updatedAt` is a
faithful "retire requested at" clock for the whole window — no new column is
strictly required for the grace period. (Caveat: `updateEnvironmentMetadata`,
environments.ts:235, is reachable via `PATCH /environments/:id` with no status
guard and bumps `updatedAt`; a metadata edit during the window *extends* it —
delay, never brick. See [open questions](#open-questions).)

### The brick path

`archiveThreadWithLifecycleEffects` → on the *last* live thread,
`archiveEnvironmentThreads` / `archiveThreadAndChildren`
(`apps/server/src/services/threads/thread-archive.ts:93-105,147-156`) call
`requestEnvironmentCleanup` (→ `retire.requested` → `retiring`) **and**
`requestEnvironmentCleanupAdvance`. The advance is deferred only by
`deferAfterResponse`/`setImmediate` (environment-cleanup-internal.ts:467-475),
then `advanceEnvironmentCleanup` dispatches `environment.destroy` in the same
turn if a daemon is connected. **There is no time delay.**

Shared environments are already safe: cleanup only fires when
`wouldCleanupEnvironment` / `countLiveThreadsInEnvironment` report **zero** live
threads (excluding the one being archived). Archiving 1-of-N never retires.

### The existing revive + sweep machinery we will reuse

- `retire.cancelled` is already fired when work resumes on a retiring env
  (`queued-messages.ts:89-94`, `thread-turn-dispatch.ts:103-108`). Unarchive does
  **not** fire it — `routes/threads/actions.ts:380` even documents the opposite
  ("does not touch the environment lifecycle"). That missing wire is the undo
  bug.
- `sweepManagedEnvironments` (`packages/db/src/data/sweeps.ts:412`) already
  returns all `retiring` managed envs with zero live threads. The periodic
  recovery sweep (`periodic-sweeps.ts`) runs `runEnvironmentCleanupAdvance` over
  them. Today it self-throttles to 15 min as a *fallback* (the archive path is
  the primary, immediate driver).

### Restore for a gone env does not exist yet

`dispatchTurnDuringReprovision` (`thread-turn-dispatch.ts:96-202`) revives a
`retiring` env in place (`retire.cancelled`, worktree intact) and reprovisions an
`error` env on the **same** row — but for `destroying`/`destroyed` it
**throws** `throwThreadEnvironmentUnavailable` (lines 111-118). There is no
fresh-environment-for-an-existing-thread path. `createProvisioningEnvironment`
(`thread-provisioning-environment.ts`) is hard-gated on a brand-new
`status:'starting'` thread with an in-memory provision context, so it cannot be
called as-is for an idle/stopped thread. Restore-from-destroyed is genuinely
net-new code.

### What is recoverable after a destroy

Managed worktrees are `git worktree add` against the **shared** source-repo object
store. `environment.destroy`'s `destroyFn` is `removeWorktree`
(`packages/host-workspace/src/provisioning.ts:489`), which runs `git worktree
remove --force` + `fs.rm` on the worktree dir — it does **not** run `git branch
-D`. So the branch ref `bb/<slug>-<threadId>` **and all its commits survive in the
source repo** after a destroy. **Committed** work is therefore recoverable;
**uncommitted / untracked** changes (only ever in the worktree dir) are gone. This
is *why the grace period is the primary fix* and Restore is best-effort secondary
recovery of committed work.

**Caveat that shapes Phase 3:** the managed provision command resets the branch.
`createWorktree` (`provisioning.ts:255`) unconditionally runs
`git worktree add -B <branchName> <targetPath> <baseBranch>`, and `-B` **resets**
an existing branch to `<baseBranch>` — which would orphan exactly the commits we
want back. So Restore cannot simply re-run the normal provision command; the
daemon must **check out the existing branch** when it already exists (see Phase 3).
A reassuring corollary: because *every* branch lives in the shared source repo and
survives the destroy, a restored worktree can `git checkout` any of them — so even
if we restore onto a slightly stale branch, the user's other branches are still
right there.

## Design

### Phase 1 — Durable grace period (fixes the brick) — ✅ IMPLEMENTED

**As shipped** (refined from the original sketch below):
- Grace duration is a server config value `managedEnvironmentRetireGraceMs`
  (`ServerRuntimeConfig`), defaulting to the `MANAGED_ENVIRONMENT_RETIRE_GRACE_MS`
  constant (10s) in production and server-unit tests, and **0** in the integration
  harness (which has no periodic sweep / time control, so it keeps immediate
  destroy-on-archive). This also answers open question #1 (grace *is* configurable).
- The authoritative grace gate lives in `advanceEnvironmentCleanup`
  (`environment-cleanup-internal.ts`), after the refreshed-status recheck and
  before the `destroy.started` claim. It defers destroy while
  `status === "retiring"`, `path !== null`,
  `Date.now() - updatedAt < config.managedEnvironmentRetireGraceMs`, **and** the env
  still has a revivable archived thread.
- **Revivability condition** (new, important): grace applies only when
  `hasRevivableArchivedThreadInEnvironment` is true — the env has a thread that is
  archived but not deleted, i.e. something to unarchive. An env left retiring by a
  *deleted/tombstoned* thread has nothing to undo, so it is cleaned up immediately
  (this is what keeps the deleted-thread reprovision path correct).
- No query-level grace predicate on `sweepManagedEnvironments` (the gate is the
  single source of truth; at a 10s window an env is "in grace" for ~one tick, so the
  per-tick no-op advance is negligible). No in-memory timer.
- The periodic recovery sweep was split: `recoverOrphanedEnvironmentDestroyRequests`
  stays 15-min throttled; the retiring sweep+advance (`advanceRetiringManagedEnvironments`)
  runs every ~10s tick, so a retired env is reclaimed roughly one tick after its
  grace window. Durable across restart via `runStartupRecoverySweep`.
- Tests: `managed-environment-cleanup-recovery.test.ts` gained a grace-deferral test
  (archived thread → retiring within window, destroyed after) and a deleted-thread
  immediate-destroy test; existing destroy/throttle tests updated. Full `@bb/server`
  (662) + `@bb/db` (305) + at-risk integration suites pass.

Original sketch (kept for reference):

Keep `retire.requested` on archive (env enters `retiring`, revivable), but **gate
the destroy** so it cannot fire for a short window. State lives in the DB row, so
it survives restart, daemon offline, and concurrency for free. The window is the
lossless-undo budget behind the archive toast — short by design.

- Add `MANAGED_ENVIRONMENT_RETIRE_GRACE_MS = 10_000` (10s, matching the toast Undo
  duration) near `MANAGED_ENVIRONMENT_ARCHIVE_CLEANUP_RECOVERY_INTERVAL_MS`
  (`periodic-sweeps.ts:60`).
- **Grace gate in `advanceEnvironmentCleanup`** (environment-cleanup-internal.ts).
  Place it **after the refreshed-status re-read/recheck block (lines 392–399) and
  before the `destroy.started` claim (line 418)**, keyed on the *refreshed* row to
  avoid a TOCTOU:
  ```ts
  if (
    refreshedEnvironment.status === "retiring" &&
    refreshedEnvironment.path !== null &&
    Date.now() - refreshedEnvironment.updatedAt < MANAGED_ENVIRONMENT_RETIRE_GRACE_MS
  ) return;
  ```
  Scope to `status === "retiring"` only: the pathless branch (no worktree to lose)
  and the `error` → destroy path (already-failed cleanup, not an accidental-archive
  brick) bypass the gate.
- The existing immediate `requestEnvironmentCleanupAdvance` archive calls now hit
  the gate and **no-op** (they fire within `setImmediate`, well under 10s). Leave
  them (lowest churn) — they're harmless — but they no longer drive the destroy.
- **Prompt cleanup at ~10s:** on archive, schedule a single deferred re-advance at
  `+MANAGED_ENVIRONMENT_RETIRE_GRACE_MS` (e.g. via the existing deferral helper /
  a 10s timer) so the destroy fires promptly once the window closes. This is an
  *optimization for cleanup latency only*; correctness does not depend on it (the
  gate is the floor, the sweep below is the durable backstop), so losing the timer
  on restart just means the sweep reclaims a few seconds later.
- **Durable backstop = the recovery sweep.** Split the 15-min self-throttle (a real
  refactor, not a one-liner — `evaluateManagedEnvironmentArchiveCleanupCandidates`
  bundles three calls and `runStartupRecoverySweep` also invokes it):
  - Keep the 15-min throttle around `recoverOrphanedEnvironmentDestroyRequests`
    only (its original purpose).
  - Let `sweepManagedEnvironments` + `runEnvironmentCleanupAdvance` run on the
    outer sweep cadence so a retiring env left behind by a missed timer (e.g.
    restart mid-window) is still reclaimed shortly after the window.
  - Add an `AND updatedAt <= now - grace` predicate to `sweepManagedEnvironments`
    (`sweeps.ts:412`) so in-grace rows are skipped at the query level (no per-tick
    no-op advance for envs still inside their 10s window).

Restart / offline / shared-env behavior (all free from the durable row):
- **Restart mid-grace:** `runStartupRecoverySweep` re-evaluates against the
  persisted `updatedAt`; destroy fires after the window, or immediately if it
  already elapsed during downtime (grace honored).
- **Daemon offline at expiry:** `workspaceCanBeDestroyedNow` already returns false
  with no connected daemon (environment-cleanup-internal.ts:130); the sweep
  pre-defers host-unavailable candidates. Offline strictly *extends* the safe
  window; the deadline is "earliest destroy", never "guaranteed destroy at".
- **Shared env:** grace only starts when the last live thread is archived; the
  `destroy.started` CAS re-asserts `NOT EXISTS live/stopping threads`
  (environments.ts:401-414), so a thread created during the sweep load→write race
  still blocks destroy.
- **`error` envs** are intentionally out of the grace window (gate keys on
  `retiring`; `sweepManagedEnvironments` returns only `retiring` rows). Confirm
  `error` → destroy is unaffected.

### Phase 2 — Undo via unarchive (loss-free revive), server — ✅ IMPLEMENTED

Shipped: the unarchive route (`routes/threads/actions.ts`) now fires
`retire.cancelled` when the thread's environment is `retiring`, reviving it to
`ready` with the worktree intact. If the env is already `destroying`/`destroyed`
the event is a no-op (the thread shows the env-gone banner → Restore). Regression
test updated in `public-thread-environment-decoupling.test.ts`.

This is the server side of the toast "Undo". Wire unarchive to the existing
`retire.cancelled` edge so undoing within the 10s window restores the **intact**
worktree (uncommitted work preserved), no reprovision. The same route also handles
the post-window case: if the env is already gone, unarchive can't revive it and the
client is routed to Restore (Phase 3).

- In the unarchive route (`routes/threads/actions.ts:383-398`), after
  `unarchiveThread`: if the thread's environment is `retiring`, fire
  `retire.cancelled` via `applyLoggedEnvironmentLifecycleEvent` (reuse the
  `queued-messages.ts:89-94` pattern). Fire it for the env regardless of which
  thread is unarchived, so an archived sibling can rescue a shared env.
- **Inspect the outcome** (don't ignore it, per critique): if `retire.cancelled`
  was *not applied* because the sweep already won the CAS (env now
  `destroying`/`destroyed`), do not silently succeed — surface env-gone / route the
  client to Restore.
- Update the stale `actions.ts:380` comment that codifies the monotonic-cleanup
  invariant this phase intentionally breaks.

### Phase 3 — Restore environment route (post-destroy recovery), server + daemon — ✅ IMPLEMENTED

Shipped (refined from the sketch below):
- **Daemon branch-preservation** (`packages/host-workspace/src/provisioning.ts`):
  `createWorktree` now checks whether the branch already exists in the source repo
  (`git show-ref`), and if so checks it out in place (`git worktree add <path>
  <branch>`) instead of `-B`-resetting it to base. This recovers committed work; a
  brand-new thread's branch never pre-exists, so it's unaffected.
- **`POST /threads/:id/restore-environment`** route + `restoreThreadEnvironment`
  service (`thread-environment-restore.ts`). Routing: `retiring` → in-place
  `retire.cancelled`; `destroying` → 409; `ready/provisioning/error` → no-op;
  pruned env (null) → 409; `destroyed` → mint a fresh env and reprovision.
- The fresh-env reprovision reuses the create-path choreography: `run.preparing`
  moves the thread `→ starting`, then a `seedWithoutRun` provisioning context with
  a `direct-managed` intent carrying the **stored branch name** (new optional
  `branchName` on the intent) creates the fresh env and re-seeds the thread into
  `idle` (no automatic turn) once the workspace is ready.
- Guards: `unmanaged` → 409 (user-owned, can't recreate); `personal` → recreates
  the empty scratch dir.
- Validated end-to-end by an integration test that commits work, archives (destroy),
  restores, and asserts the committed file reappears in the fresh worktree on the
  same branch.

Original sketch (kept for reference):

For a thread whose env is genuinely gone. **`destroyed` is terminal — do not add a
`destroyed → provisioning` edge.** Mint a fresh environment row and repoint the
thread. This is net-new (the existing reprovision paths operate on the same row and
reject gone envs at `thread-turn-dispatch.ts:111-118`).

The earlier "blocker" (the create path is gated on a `starting` thread with an
in-memory provision context) is **surmountable**: `run.preparing` is a legal
`idle→starting` and pre-start-`error`→`starting` transition
(`packages/domain/src/thread-lifecycle.ts`; already used at
`thread-turn-dispatch.ts:141-149`). So Restore re-enters the *existing* thread
provisioning choreography rather than hand-rolling it — with two corrections the
naive "just reuse the create path" misses (branch name + the `-B` reset).

`POST /threads/{id}/restoreEnvironment` (thread-scoped; next to unarchive), plus a
server-contract entry (`noRequest<PathId>()` → `{ ok: true }`, exactly like
`unarchive`). Behavior by current env status:

1. If the thread is archived, unarchive first (one-click restore from an env-gone
   archived thread).
2. `retiring` → route to the cheap in-place `retire.cancelled` revive and return
   (worktree intact; no new row). *(This is the same revive as Phase 2.)*
3. `destroying` → reject `409` ("Environment is still being torn down; try again
   shortly"). Client retries once status flips to `destroyed`.
4. `destroyed` (or `environmentId === null`) → mint a fresh env and re-enter
   provisioning:
   - `createEnvironment` (`packages/db/src/data/environments.ts:36`) with
     `status:'provisioning'`, copying `hostId / projectId / workspaceProvisionType
     / branchName / baseBranch / mergeBaseBranch` from the destroyed row. Created
     directly in `provisioning` — **no `provision.requested` event** (the lifecycle
     has no such cell from `provisioning`; mirror
     `createPreparedProvisioningEnvironment`'s "no provision.requested event here",
     `thread-provisioning-environment.ts:651-652`).
   - Repoint `thread.environmentId` to the new row, then `run.preparing` to move
     the thread `→ starting` (so `advanceThreadProvisioning`'s `status==='starting'`
     gate at `thread-provisioning.ts:350` is satisfied).
   - Build the `environment.provision` command from the **stored**
     `environment.branchName` (not a re-derived `buildManagedBranchName` — that would
     produce a *different* branch and miss the commits). This is exactly
     `dispatchManagedEnvironmentReprovision`'s branch source
     (`environment-provisioning-internal.ts:1087-1092`:
     `environment.branchName ?? buildManagedBranchName`, base via
     `storedBaseBranchNameToSpec`), applied to the **fresh** row. Then drive
     `advanceEnvironmentProvisioning` + `advanceThreadProvisioning` to start the
     thread once the workspace is ready. (Do **not** call
     `dispatchManagedEnvironmentReprovision` itself — it fires `provision.requested`
     on an existing non-terminal row.)
   - **Rollback:** if create/provision fails before the repoint commits, roll
     `thread.environmentId` back (to the destroyed row, or null) so a failed restore
     never strands the thread on a half-born env.
   - **DAEMON CHANGE (required for committed-work recovery):** today
     `createWorktree` (`provisioning.ts:255`) always does `git worktree add -B
     <branch> <base>`, which **resets** the surviving branch to base and orphans its
     commits. Change it to **check out an existing branch in place**: if `branchName`
     already exists in the source repo, `git worktree add <targetPath> <branchName>`
     (no `-B`, preserves the tip); else create from base as today. This is small and
     contained, and also makes error-recovery reprovision branch-safe. Without it,
     Restore "succeeds" but silently discards the very commits it promised.
5. Guards (verified with provision type):
   - `managed-worktree` → full restore (the above).
   - `unmanaged` → `409`. The workspace is **user-owned**; bb never created it and
     can't safely recreate it (`dispatchManagedEnvironmentReprovision` already 409s
     unmanaged at `environment-provisioning-internal.ts:1030`). Hide the Restore
     affordance for unmanaged envs.
   - `personal` → recreate the empty scratch dir only (personal is a non-git
     `mkdir`'d dir, `provision.ts` `provisionPersonalWorkspace`); the confirm dialog
     must say "this creates an empty workspace; previous contents are gone".
   - offline daemon → provision queues as normal (no special handling).
6. **Post-TTL fallback:** `pruneDestroyedEnvironments` hard-deletes destroyed rows
   after `DESTROYED_ENVIRONMENT_TTL_MS` (7 days; `sweeps.ts`), and
   `threads.environmentId` is `onDelete:'set null'`. A pruned env leaves the thread
   with `environmentId === null` and **no** branch/host metadata (those lived on the
   deleted row; the thread row carries only `projectId`). Restore then falls back to
   project defaults (default host, default branch, managed worktree) like a
   brand-new thread env — or returns `410`. Decide + document; do not imply branch
   recovery post-prune.

No new `EnvironmentLifecycleEvent` or `ThreadLifecycleEvent` types are required.
The only non-server change is the daemon `createWorktree` branch-preservation tweak
in 4.

### Phase 4 — Frontend Restore affordance + undo toast — ✅ IMPLEMENTED

Shipped:
- `ThreadPromptEnvironmentGoneSection` gained `onRestore`/`restorePending`; the
  read-only banner renders an `EnvironmentRestoreTextAction` in the statusAction
  slot — "Restore environment" when `destroyed`, a disabled "Cleaning up…" while
  `destroying`. Banner tests cover both.
- `api.restoreThreadEnvironment` + `useRestoreThreadEnvironment` (relies on the
  realtime channel to refresh the thread/environment after reprovision); wired
  through `ThreadDetailPromptArea`.
- **Archive Undo toast**: `useArchiveThread` now shows a 10s "Thread archived —
  Undo" toast; Undo un-archives, which revives a still-`retiring` environment
  losslessly. The durable banner Unarchive remains as the fallback after the toast.
- No confirm modal (see decision at top). `SideChatTabContent` was investigated
  and needs **no** parity: its "This side chat is no longer available" copy
  (`SideChatTabContent.tsx:289`) is a `missingThreadLabel` for a *not-found
  thread*, not an environment-gone surface — there is nothing to restore.

Original sketch (kept for reference):

- Extend `ThreadPromptEnvironmentGoneSection` (`ThreadPromptContextBanner.tsx:93`)
  with `onRestore?` / `restorePending?`, mirroring `ThreadPromptArchivedSection`.
  In `ReadOnlyContextBanner` the `statusAction` slot currently renders only for
  `archivedSection?.onUnarchive` (lines 575-582) — extend it to render an
  `EnvironmentRestoreTextAction` (clone of `ThreadUnarchiveTextAction`) when
  `environmentGoneSection?.onRestore` exists: disabled "Cleaning up…" on
  `destroying`, active "Restore environment" on `destroyed` (keep `CircleX`).
- **Confirm dialog** (uncommitted work is gone): "Restore environment? We'll create
  a fresh workspace and check out branch `<branchName>`. Committed and pushed work
  on that branch is preserved. Uncommitted changes, untracked files, and unpushed
  local commits were lost when the old workspace was torn down."
- Client: `api.restoreEnvironment` (`apps/app/src/lib/api.ts`) + `useRestoreEnvironment`
  (model on `useUnarchiveThread`, thread-state-mutations.ts:231-255); invalidate
  thread + environment queries `onSettled` so the banner flips through provisioning
  back to a live composer. Wire `onRestore`/`restorePending` from
  `ThreadDetailPromptArea` (~line 970) / `ThreadDetailView`.
- **Undo toast on last-thread archive (the lossless undo):** an `appToast` ("Thread
  archived — workspace will be cleaned up" / "Undo", duration **10s** = the grace
  window) calling the unarchive mutation. This is the *only* lossless undo — within
  10s it fires `retire.cancelled` and the worktree is intact. Show it only when the
  archive actually retired the env (last live thread); a non-last archive keeps the
  env and needs no toast.
- **After the 10s window** the worktree is gone, so the recovery affordance is
  **Restore** (lossy, committed-only), not lossless Unarchive. An archived thread
  whose env is destroyed shows the env-gone banner with "Restore environment"
  (Restore unarchives first, then reprovisions — Phase 3 step 1). `ThreadDetailView`
  already flags only `destroying`/`destroyed` as env-gone; no new in-grace banner
  state is needed since the 10s window is covered by the toast.

### Phase 5 — Hardening + parity (follow-up)

- Race/robustness matrix: `retire.cancelled` vs sweep-fired `destroy.started` at the
  window edge (CAS picks one winner; better-sqlite3 serialized immediate txns make
  it well-defined); shared-env all-gone precondition + destroy CAS re-check; restart
  mid-grace; daemon-offline-at-expiry deferral; destroyed-row TTL covers restore-retry.
- ~~Mirror the Restore affordance in `SideChatTabContent`~~ — resolved: that
  surface is thread-not-found, not env-gone, so no Restore affordance applies.
- Decide whether to promote the grace clock to a dedicated nullable
  `environments.retiredAt` column (stamp on `retire.requested`; clear on
  `retire.cancelled`/`destroy.started`) — needed only for a precise frontend
  countdown or to immunize the clock from `updateEnvironmentMetadata` writes.

## Implementation checklist (files to touch)

Verified call sites for a fast start. Order: Phase 1 → 2 → 3 → 4.

**Phase 1 — grace gate (server):**
- `apps/server/src/services/system/periodic-sweeps.ts` — add
  `MANAGED_ENVIRONMENT_RETIRE_GRACE_MS = 10_000` (~line 60); split the 15-min
  throttle so `recoverOrphanedEnvironmentDestroyRequests` stays throttled but
  `sweepManagedEnvironments` + `runEnvironmentCleanupAdvance` run each tick.
- `apps/server/src/services/environments/environment-cleanup-internal.ts` — add the
  grace early-return in `advanceEnvironmentCleanup` after the refreshed-status recheck
  (~lines 392–399), keyed on `refreshedEnvironment.updatedAt`.
- `packages/db/src/data/sweeps.ts` — add `AND updatedAt <= now - grace` to
  `sweepManagedEnvironments` (~line 412).
- Tests: `apps/server/test/services/managed-environment-cleanup-recovery.test.ts` (or
  a new sibling), in-memory SQLite.

**Phase 2 — unarchive revives (server):**
- `apps/server/src/routes/threads/actions.ts` — unarchive handler (~lines 383–398):
  after `unarchiveThread`, if env is `retiring` fire `retire.cancelled`
  (`applyLoggedEnvironmentLifecycleEvent`, pattern at `queued-messages.ts:89-94`);
  inspect the outcome and route to Restore if already gone. Update the stale comment
  at `actions.ts:380`.

**Phase 3 — restore route (server) + daemon branch fix:**
- `packages/server-contract/src/public-api.ts` — add `restoreEnvironment` route next
  to `archive`/`unarchive` (~line 646): `noRequest<PathId>()` → `{ ok: true }`.
- `apps/server/src/routes/threads/actions.ts` — new `post(routes.restoreEnvironment, …)`
  handler implementing the status routing in Phase 3. Reuses `createEnvironment`,
  `attachThreadToEnvironment`/`updateThread`, `run.preparing`,
  `advanceEnvironmentProvisioning`, `advanceThreadProvisioning`.
- `packages/host-workspace/src/provisioning.ts` — `createWorktree` (~line 255):
  check out an existing branch in place instead of `-B`-resetting it.

**Phase 4 — UI:**
- `apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx` — extend
  `ThreadPromptEnvironmentGoneSection` (~line 93) with `onRestore?`/`restorePending?`;
  add an `EnvironmentRestoreTextAction` in the `ReadOnlyContextBanner` statusAction
  slot (~lines 575–582). Only surface Restore for managed envs (unmanaged → hidden).
- `apps/app/src/lib/api.ts` — `restoreEnvironment(id)` next to `unarchiveThread` (~1267).
- `apps/app/src/hooks/mutations/thread-state-mutations.ts` — `useRestoreEnvironment`
  (model on `useUnarchiveThread`, ~lines 231–255), invalidate thread + environment.
- `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx` — wire
  `onRestore`/`restorePending` into `environmentGoneSection` (~line 970), mirroring
  the `handleUnarchiveCurrentThread` wiring.
- Add the archive Undo `appToast` (10s) and the Restore confirm dialog.

## T3 checkpointing evaluation

**Verdict: out of scope for this change; file as an independent follow-up at most.**

The reported pain is a **timing** problem, not a durability one. The grace period
prevents destruction during the window, and `retire.cancelled`-on-unarchive gives
**loss-free** undo of the *live* worktree (uncommitted + untracked included) —
strictly better than any checkpoint, which can only restore a committed snapshot.
Restore then recovers committed/pushed work after the window for free (the shared
object store survives `git worktree remove`). So checkpointing would only buy back
the narrow residual: *user ignored the grace window AND had valuable uncommitted
edits AND a turn boundary had fired to snapshot them.*

Cost is a new subsystem, the opposite of smallest-correct-change: none of the
pieces exist (no `workspace.captureCheckpoint`/`restoreCheckpoint` daemon commands,
no `turn/completed` checkpoint reactor, no per-env+turn ref namespace, no
restore-to-arbitrary-SHA op — current workspace reset is hard-reset-to-HEAD), plus
the conversation-rollback coupling T3 itself flags as the real work.

There is also a **self-conflict**: T3's hygiene rule is "delete checkpoint refs on
archive" (to bound orphan-commit growth), but Restore's value is recovering work
*after* archive/destroy. If archive deletes the refs, they're gone exactly when
Restore would use them. Making checkpoints useful for Restore requires the opposite
— retain env-scoped refs and GC them at the destroyed-env TTL
(`DESTROYED_ENVIRONMENT_TTL_MS`), a deliberate retention design that must be owned
from day one, not bolted on here. (It is technically feasible — refs in the shared
`.git` do survive a worktree destroy — which is why it's a *follow-up*, not
*infeasible*.)

Recommendation: ship grace + undo + restore first; gate any checkpoint work on
telemetry showing post-grace uncommitted-loss is real and frequent. If pursued,
frame it as "recover uncommitted work after the grace window or a hard crash," own
the ref namespace + TTL-aligned GC, and reuse the Restore confirm dialog built here
as the insertion point ("Recover work from last checkpoint"). Building Restore now
does not foreclose it.

## Exit criteria

- **Grace period:** archiving the last live thread leaves the env `retiring` with
  the worktree intact for the full window; `destroy.started` fires only after
  `window + one sweep tick`; restart mid-window still destroys after the window;
  daemon offline at expiry defers (no lost timer); archiving a non-last thread never
  enters `retiring`.
- **Undo:** unarchiving within the window returns the env to `ready` with
  uncommitted/untracked work preserved and the composer re-enabled; a
  `destroy.started`-won race routes to Restore rather than silently succeeding.
- **Restore:** a thread on a `destroyed` managed env gets a new provisioning env on
  the same branch; committed/pushed work reappears; `409` on `destroying` with a
  documented retry-after-flip; `unmanaged` → `409`; failed provision rolls back the
  repoint; double-click is idempotent; pruned-env path falls back to project
  defaults (or `410`) per the recorded decision.
- **UI:** env-gone banner shows a working Restore button (disabled during
  `destroying`, active on `destroyed`); confirm dialog states what is/ isn't
  recoverable; archive shows an Undo toast that reverts within the window, with the
  banner Unarchive as durable fallback.

## Validation

- New unit tests around `advanceEnvironmentCleanup`: no `destroy.started` within the
  window; dispatch after it; `error`-status destroy unaffected by the gate. Reuse
  in-memory SQLite (`createConnection(":memory:")` + `migrate(db)`); never mock the DB.
- Lifecycle tests: extend `packages/domain/test/environment-lifecycle.test.ts` only
  if new transitions are added (none planned) — otherwise assert the route/sweep
  behavior in server tests.
- Integration: archive-last-thread → assert `retiring` + worktree present on disk →
  unarchive → assert `ready` + worktree intact; let the window elapse → assert
  `destroyed` + worktree gone; restore → assert fresh env provisions on the branch
  and committed work is present.
- Race test (Phase 5): interleave unarchive and the sweep at the window edge; assert
  a single CAS winner and that the loser path is handled.
- Manual QA via `scripts/bb-dev-app` + `pnpm bb:dev thread …` to watch the banner
  transition through provisioning back to a live composer.
- Typecheck/build/test via Turbo per `AGENTS.md`
  (`pnpm exec turbo run typecheck|test --filter=@bb/<pkg>`); pipe slow test output to
  a file.

## Open questions

1. ~~**Grace window length / configurability**~~ — **resolved**: 10s default,
   surfaced as the archive toast's Undo, and now a server config value
   (`managedEnvironmentRetireGraceMs`) so it is tunable (and set to 0 in the
   integration harness). Revisit the default only if 10s proves too tight.
2. **Grace clock storage** — **no new column** (the `retiring` row's `updatedAt` is
   a faithful clock). The 10s window makes this clearly correct: the only in-place
   writer that touches `updatedAt`, `updateEnvironmentMetadata` (PATCH
   /environments/:id), would have to land within a 10s window to perturb it, and the
   only effect is a few seconds' extra delay — never a brick. A dedicated
   `environments.retiredAt` column is unnecessary unless a precise countdown UI is
   later wanted.
3. ~~**In-grace UI**~~ — **resolved**: the 10s toast Undo covers the in-grace state;
   no separate `retiring` banner treatment. After the window, the env-gone banner's
   Restore takes over.
4. ~~**Personal/unmanaged Restore**~~ — **resolved**: `managed-worktree` → full
   restore; `unmanaged` → `409` + hide the affordance (user-owned workspace bb can't
   recreate); `personal` → recreate the empty scratch dir with an explicit "previous
   contents are gone" confirmation.
5. ~~**Branch staleness on Restore**~~ — **resolved as a minor, documented
   limitation**: `environment.branchName` is set once at provision time from the
   daemon's `getCurrentBranch()` and never re-synced
   (`environment-provisioning-internal.ts:603`), so a manual terminal `git checkout`
   isn't tracked and Restore re-checks-out the *stored* branch. Low stakes: every
   branch survives the destroy in the shared source repo, so the restored worktree
   can `git checkout` the user's other branch. Name the stored branch in the confirm
   dialog; no pre-destroy re-discovery is possible (the worktree is already gone).
