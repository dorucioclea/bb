import { getEnvironment, getThread, unarchiveThread } from "@bb/db";
import type { Environment, Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { applyLoggedEnvironmentLifecycleEvent } from "../environments/lifecycle-outcome.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  requireSourceForHost,
  storedBaseBranchNameToSpec,
} from "./thread-create-helpers.js";
import { createClientTurnRequestId } from "./thread-events.js";
import {
  createMetadataPendingContext,
  type ThreadProvisionEnvironmentIntent,
} from "./thread-provisioning-context.js";
import { advanceThreadProvisioning } from "./thread-provisioning.js";
import { saveThreadProvisionContext } from "./thread-provisioning-environment.js";

interface RestoreThreadEnvironmentArgs {
  threadId: string;
}

/**
 * Builds the provisioning intent for a fresh environment that replaces a gone
 * one. Managed worktrees re-checkout the destroyed environment's exact branch so
 * its committed work is recovered (the daemon checks the branch out in place);
 * personal workspaces are recreated empty. Unmanaged workspaces are user-owned
 * and cannot be recreated.
 */
function restoreEnvironmentIntent(
  deps: AppDeps,
  thread: Thread,
  destroyed: Environment,
): ThreadProvisionEnvironmentIntent {
  if (!destroyed.managed || destroyed.workspaceProvisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "This environment is unmanaged and can't be restored automatically.",
    );
  }
  if (destroyed.workspaceProvisionType === "personal") {
    return {
      type: "direct-personal",
      hostId: destroyed.hostId,
      workspaceProvisionType: "personal",
    };
  }
  const source = requireSourceForHost(deps, thread.projectId, destroyed.hostId);
  return {
    type: "direct-managed",
    hostId: destroyed.hostId,
    sourcePath: source.path,
    baseBranch: storedBaseBranchNameToSpec(destroyed.baseBranch),
    workspaceProvisionType: "managed-worktree",
    ...(destroyed.branchName ? { branchName: destroyed.branchName } : {}),
  };
}

/**
 * Restores a working environment for a thread whose environment is gone.
 *
 * - `retiring` (still inside the archive grace window): revives the environment
 *   in place via `retire.cancelled`; the worktree is intact, so nothing is lost.
 * - `destroying`: the tear-down RPC is in flight; reject with 409 so the client
 *   retries once the row reaches `destroyed`.
 * - `destroyed` (or the row was already pruned to null): mints a fresh
 *   environment and reprovisions it. For a managed worktree the destroyed
 *   branch is re-checked-out (recovering committed work); uncommitted work was
 *   lost when the worktree was torn down. The thread is re-seeded into `idle`
 *   (no automatic turn) so the user continues from their next message.
 * - anything else (`ready`/`provisioning`/`error`): the environment is not gone,
 *   so this is a no-op.
 *
 * An archived thread is un-archived first so Restore is one click from the
 * read-only banner.
 */
export async function restoreThreadEnvironment(
  deps: AppDeps,
  args: RestoreThreadEnvironmentArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }

  if (thread.archivedAt !== null) {
    unarchiveThread(deps.db, deps.hub, thread.id);
  }
  const currentThread = getThread(deps.db, thread.id) ?? thread;

  const environment = currentThread.environmentId
    ? getEnvironment(deps.db, currentThread.environmentId)
    : null;

  if (environment?.status === "retiring") {
    // Lossless undo: still inside the grace window, the worktree is intact.
    applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: { type: "retire.cancelled" },
    });
    return;
  }
  if (environment?.status === "destroying") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment is still being torn down; try again shortly.",
    );
  }
  if (environment && environment.status !== "destroyed") {
    // ready / provisioning / error — the environment is not gone; nothing to do.
    return;
  }

  if (!environment) {
    // The destroyed row was pruned (no branch/host metadata survives), so there
    // is nothing to reprovision against. Surface it instead of guessing.
    throw new ApiError(
      409,
      "environment_not_ready",
      "This environment was cleaned up and can no longer be restored. Start a new thread.",
    );
  }

  const intent = restoreEnvironmentIntent(deps, currentThread, environment);

  // Move the thread back to `starting` so the provisioning advance runs. Legal
  // from idle and error (the statuses a thread lands in when its environment is
  // destroyed); a no-op otherwise, which then short-circuits the advance.
  const preparing = applyLoggedThreadLifecycleEvent(deps, {
    threadId: currentThread.id,
    event: { type: "run.preparing" },
  });
  if (!preparing.applied) {
    throw new ApiError(
      409,
      "thread_not_writable",
      "This thread can't be restored from its current state.",
    );
  }
  deps.hub.notifyThread(currentThread.id, ["status-changed"]);

  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: currentThread.id },
    "client/turn/requested",
  );
  // seedWithoutRun re-seeds the thread into `idle` once the workspace is ready
  // without dispatching a turn — Restore brings the environment back, it does
  // not run the agent.
  const context = createMetadataPendingContext({
    clientRequestId: createClientTurnRequestId(),
    environmentIntent: intent,
    execution,
    fork: null,
    input: [],
    titleProvided: true,
    seedWithoutRun: true,
  });
  saveThreadProvisionContext({ threadId: currentThread.id, context });
  await advanceThreadProvisioning(deps, {
    context,
    threadId: currentThread.id,
  });
}
