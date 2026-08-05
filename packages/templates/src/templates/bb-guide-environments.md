---
kind: instruction
title: bb Guide — Environments
summary: Command reference for environment setup, inspection, commits, and merges.
intent: Provide complete environment command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Environment commands

Environments determine where threads run. Multiple threads can share an environment
(e.g., a coding thread and a review thread in the same worktree).

Making your repo work with bb:

  Commit a .bb-env-setup.sh script at the repo root when new bb worktrees need
  repo-specific setup. After bb creates a new managed worktree environment, it
  looks for .bb-env-setup.sh inside that new workspace. If the file is absent,
  provisioning continues with no error.

  The script must be tracked by git. A fresh worktree only checks out tracked
  files, so an untracked .bb-env-setup.sh in your source checkout will not be
  present and will not run.

  BB runs the hook as `env bash .bb-env-setup.sh` with cwd set to the new
  workspace. POSIX shell setup scripts are not supported on Windows. The hook
  inherits the host daemon's sanitized environment: NODE_ENV and every BB_*
  variable are removed, and bb does not inject BB_PROJECT_ID, BB_ENVIRONMENT_ID,
  or BB_SOURCE_PATH.

  The hook runs only for newly-created managed worktree environments. It does
  not run for direct/project-checkout environments, personal scratch workspaces,
  or reconnecting an existing managed worktree.

  A non-zero exit, timeout, signal, or cancellation fails provisioning and bb
  removes the new worktree. Keep optional setup steps non-fatal inside the
  script if the environment should still open. Provisioning progress reports
  "Running .bb-env-setup.sh" and then ".bb-env-setup.sh finished",
  ".bb-env-setup.sh failed", or ".bb-env-setup.sh cancelled".

  New worktrees do not contain untracked files such as .env.local. To copy
  them from the source checkout, commit a .worktreeinclude file at the repo
  root. It uses gitignore syntax: one pattern per line, # for comments, ! to
  negate an earlier pattern. bb copies each untracked file in the source
  checkout that matches a pattern:

    .env
    .env.*
    !.env.example
    certs/

  bb copies files only. It follows no symlinks, and it replaces nothing that
  the worktree already has. The copy runs after `git worktree add` and before
  .bb-env-setup.sh, so the setup script can read the copied files. A pattern
  that matches nothing, or a file bb cannot read, is reported in the
  provisioning transcript and does not fail provisioning.

  Large directories such as node_modules are copied file by file. Install
  dependencies in .bb-env-setup.sh instead of listing them here.

  For files that customize agent instructions and skills (AGENTS.md,
  .bb/AGENTS.md, .bb/skills/), run `bb guide agent-configuration`.

  bb environment show <id>                Show environment details (path, branch, status)

  bb environment status <id>              Show workspace status
    --merge-base-branch <branch>          Include merge-base status

  bb environment branches <id>            List local and remote branches
    --query <query>                       Filter branch names
    --limit <count>                       Limit local and remote results

  bb environment paths <id>               Search workspace paths
    --query <query>                       Fuzzy path query
    --limit <count>                       Maximum results
    --files                               Include only files unless combined with --directories
    --directories                         Include only directories unless combined with --files

  bb environment diff <id>                Show file summary and full git diff
  bb environment diff-files <id>          List changed-file metadata
    --target <target>                     uncommitted, branch_committed, all, or commit (required)
    --merge-base-branch <branch>          Required for branch_committed and all
    --sha <sha>                           Required for commit

  bb environment diff-file <id>           Read one side of a changed file
    --target <target>                     Diff target (required)
    --path <path>                         Repository-relative path (required)
    --side <old|new>                      File side (required)
    --merge-base-ref <sha>                Required for branch_committed and all
    --sha <sha>                           Required for commit

  bb environment diff-patch <id>          Fetch selected file patches
    --target <target>                     Diff target (required)
    --path <path>                         Changed path; repeat for multiple files (required)
    --merge-base-branch <branch>          Required for branch_committed and all
    --sha <sha>                           Required for commit

  bb environment update <id>              Update environment metadata
    --merge-base-branch <branch>          Set merge-base branch override
    --clear-merge-base-branch             Clear merge-base override
    --name <name>                         Set display name
    --clear-name                          Clear display name

  bb environment commit <id>              Create a commit in the environment

  bb environment squash-merge <id>        Squash-merge into a target branch
    --merge-base-branch <branch>          Target branch (required)

  bb environment archive-threads <id>     Archive all threads in an environment

  bb environment pull-request show <id>   Inspect a pull request
  bb environment pull-request ready <id>  Mark a pull request ready
  bb environment pull-request draft <id>  Convert a pull request to draft
  bb environment pull-request merge <id>  Merge a pull request
    --method <method>                     merge, squash, or rebase

Every inspection command accepts an arbitrary environment ID and supports
`--json`. Non-git status/diff responses are reported explicitly. `diff-file`
prints UTF-8 content directly and labels base64 binary content; diff and patch
truncation markers are preserved.

bb Cloud (bb connect):

  Connect this bb server to bb Cloud (getbb.app). Once connected it is
  reachable from any browser at <handle>.getbb.app, port shares work through
  the account, and AI features (thread titles, commit messages, voice
  transcription) run through it. Claim a handle at https://getbb.app, copy the
  connect command it generates, then run it here to
  pair:

  bb connect --code <code> --server https://<handle>.getbb.app
    --code <code>          One-time pairing code from the dashboard
    --server <url>         https://<handle>.getbb.app (from the dashboard)

  Pairing returns immediately: the bb SERVER redeems the code, stores the
  credential, and holds the tunnel itself — so it stays up as long as bb is
  running and reconnects on restart (no foreground process).
  Without an installed bb, pair via npm:
  `npx -p bb-app@latest bb connect --code <code> --server <url>`.

  bb connect status                       Show the server's bb Cloud status
  bb connect off                          Disconnect and forget the pairing
  bb connect ai [on|off]                  Show or set the AI features setting
  bb connect expose <port> [--host <name-or-id>]    Share a host's HTTP port
  bb connect unexpose <port> [--host <name-or-id>]  Stop sharing on that host
  bb connect shares [--host <name-or-id>]           List that host's shares
  bb connect servers                      List every bb on this account (handle, url, live)

  Port sharing works from threads on any enrolled host. In a thread,
  `bb connect expose <port>` resolves the thread environment's host; outside a
  thread it defaults to the server host. `--host <name-or-id>` overrides that
  choice for expose, unexpose, and shares. Server-host URLs use
  `https://<server-label>--<port>.getbb.app`; machine-host URLs use
  `https://<machine-label>--<port>.getbb.app` and proxy directly through that
  machine's daemon. Access is owner-session-gated — only viewers signed into
  the owner's getbb.app account can open the URL; it is not a public internet
  link. Agents should run expose from the thread that started the server, share
  the returned URL, and unexpose from the same thread when it stops.
  `bb connect status` shows all shares with host + URL. `shares --json` returns
  the resolved `host` and rows with `hostId`, `hostName`, `port`, and `url`.

  While connected, AI features route thread-title inference, commit-message
  inference, and voice transcription through the account's bb Cloud AI proxy
  by default (no local AI credentials needed); bb falls back to the locally
  configured providers on any cloud failure, and `bb connect ai off` turns
  the routing off entirely.

  bb Cloud is owned by the builtin "connect" plugin (Settings → bb Cloud
  shows the URL, QR code, shared ports, and the AI features toggle).
  Disabling the plugin (`bb plugin disable connect`) cuts off all bb Cloud
  capabilities; re-enable with `bb plugin enable connect`.
