---
name: backranq-orchestrator
description: Coordinate Backranq repository tasks with current-state discovery, scoped planning, optional delegation, independent review, integration, and proportionate verification. Use for Backranq work that is broad, multi-step, risky, cross-cutting, review-heavy, long-running, or explicitly asks for agents, parallel lanes, branches, PRs, CI investigation, integration, or deployment coordination. It may also guide smaller Backranq tasks, but activation alone must not cause delegation or external writes. Derive all repository facts, policies, and commands from the current checkout; never rely on stored Backranq snapshots.
---

# Backranq Orchestrator

## Core Contract

- Treat the current checkout and its applicable instructions as the source of truth.
- Use this skill as a workflow, not as repository documentation. Never infer the current stack, architecture, routes, backlog, scripts, deployment target, or test coverage from this file or from a previous run.
- Keep the primary thread responsible for scope, decisions, coordination, review, integration, verification, and reporting.
- Preserve the user's scope. Do not turn an ordinary task into a repository-wide audit or cleanup.
- Prefer the simplest execution mode that can complete the task safely.

## Choose an Execution Mode

### Solo mode

Use one agent when the task is one coherent lane, the likely edits overlap heavily, or delegation would cost more than it saves. Follow the same discovery, review, and verification gates without spawning workers merely because the skill is active.

### Orchestrated mode

Use explorers or workers when the user requests agents or when at least two genuinely independent lanes can make useful progress in parallel. Keep lanes disjoint, schedule them in dependency-aware waves, and retain coordinator capacity for integration and user communication.

### Publication mode

Add branches, commits, pushes, PRs, merges, external comments, configuration changes, or deployments only when the user's request or an explicit run policy authorizes those actions. Treat approval for one external action as approval for that action only.

## Refresh Context Before Planning

1. Resolve the actual repository root, current directory, branch, HEAD SHA, remotes, worktrees, and concise working-tree status.
2. Read every applicable `AGENTS.md` and other project instruction file before taking task actions. Let newer and more specific instructions override this workflow.
3. Inspect the current task-relevant source, documentation, configuration, package scripts, lockfile/toolchain declarations, and CI workflows. Read only the environment-variable names needed for the task; never print secret values.
4. Inspect existing changes before editing. Distinguish committed baseline behavior from uncommitted user work when that difference affects the conclusion or implementation.
5. Define the mission contract: requested outcome, non-goals, base revision, allowed local and external writes, success criteria, verification gates, stop conditions, and unresolved product decisions.

Repeat the relevant discovery step whenever the branch, worktree, base revision, instructions, or task scope changes.

## Protect Existing Work

- Treat all pre-existing modifications and untracked files as user-owned unless proven otherwise.
- Never discard, overwrite, stage, commit, or reformat unrelated work.
- Inspect overlapping changes and integrate with them only when intent is clear. Ask for direction when overlap creates a material product or ownership ambiguity.
- Allow read-only explorers to share a checkout. Give concurrent editing workers isolated worktrees or otherwise provably disjoint files rooted at an explicit base SHA.
- Assign shared interfaces, schemas, central configuration, generated artifacts, and dependency files to one lane at a time.
- Tell every agent that other work may be present and that reverting unrelated changes is forbidden.

## Plan from the Current Task

Build a small dependency graph instead of using predefined Backranq lanes. For each lane, record:

- the concrete outcome and acceptance criteria;
- the exact files, modules, or behavior it owns;
- the base SHA and branch or worktree expectation;
- dependencies and interfaces with other lanes;
- allowed actions and explicit non-goals;
- focused and integrated verification;
- the required handoff: diff, files changed, behavior, commands run, results, risks, and blockers.

Keep tightly coupled implementation and its regression tests in the same lane. Create a shared tooling lane only when multiple workers truly depend on it. Start downstream lanes only after their required contracts are stable.

## Execute and Coordinate

1. Use explorers for bounded read-only questions whose answers unblock planning or reduce implementation risk.
2. Use workers for bounded patches with clear ownership. Do not duplicate delegated work in the coordinator thread.
3. Continue useful non-overlapping coordinator work while agents run.
4. Review agent output and the actual diff; do not accept a summary as proof of implementation.
5. Route actionable findings back to the owning worker and repeat focused verification after each correction.
6. Integrate by understanding every side of a conflict. Never resolve a conflict by dropping inconvenient or unrelated work.

Do not create more concurrent lanes than the available capacity can support. Prefer a short second wave over broad, weakly supervised parallelism.

## Worker Contract

Give each worker the mission contract plus:

- exact ownership and non-overlap boundaries;
- whether to stop at a local diff, commit, push, or PR;
- current project instructions and relevant discovered context;
- the smallest useful focused checks and the expected integrated checks;
- a requirement to report changed files, verification results, behavior changes, risks, blockers, and the next recommended action.

Require workers to adapt to concurrent changes, avoid unrelated cleanup, and stop before any unapproved external or destructive action.

## Review Contract

Review the diff against its exact base revision and task contract. Lead with actionable findings ordered by severity and cite precise files and lines. Check at least:

- correctness and user-visible regressions;
- authorization, ownership, validation, destructive behavior, and transaction boundaries where relevant;
- concurrency, retry, idempotency, and partial-failure behavior where relevant;
- migration, configuration, dependency, generated-file, and deployment risk where relevant;
- regression coverage and whether the chosen checks exercise the changed behavior;
- scope creep, unrelated cleanup, and accidental loss of pre-existing work.

State `clean` only when no actionable finding remains. Otherwise state `changes requested` and return findings to their owning lane.

## Derive Verification Dynamically

- Derive commands from the current package scripts, project documentation, CI workflows, and files changed. Do not preserve command lists in this skill.
- Run focused checks during implementation, then the repository's current canonical broad check when one exists.
- Mirror all relevant CI lanes before integration when practical, especially for changes to databases, migrations, runtimes, queues, browser behavior, deployment configuration, or external integrations.
- Use browser verification when layout, navigation, authentication, offline behavior, console errors, or complete user journeys matter.
- Keep routine tests isolated from live providers and real production systems. Run credentialed, live, destructive, or expensive checks only when explicitly authorized and safely targeted.
- Record every command actually run and its result. Never imply that an unrun check passed.
- If a required check cannot run, report the exact blocker and the remaining risk instead of weakening the success criteria silently.

## Safety and Authority

- Validate targets and inputs before mutation. Make malformed or unauthorized operations fail before writes.
- Prefer bounded, retryable, idempotent, and transactionally coherent operations when the changed behavior requires them.
- Resolve destructive targets with read-only checks and keep them precisely scoped.
- Never run migrations or data mutations against shared or production systems without explicit authorization for that target.
- Never expose secrets in prompts, logs, diffs, commits, screenshots, or reports.
- Obey the current repository policy for compatibility, data preservation, branch protection, integration, and production deployment rather than encoding those policies here.
- Do not push, open or modify PRs, merge, deploy, change hosted settings, or send external comments unless already authorized for the current run.

## Integrate and Finish

Before declaring completion:

1. Re-read the mission contract and inspect the integrated diff against the exact base.
2. Confirm every lane is integrated or explicitly excluded.
3. Confirm actionable review findings are resolved.
4. Run the current focused and integrated verification gates.
5. Check final repository status for accidental, generated, secret-bearing, or unrelated files.
6. Report the outcome, changed scope, verification evidence, branch/commit/PR state when applicable, behavior changes, residual risks, blockers, and any user decision still needed.

For long-running work, create a heartbeat or continuation loop only when the user asks for ongoing monitoring or persistence. Let it inspect current state, collect worker results, route review feedback, and start only approved lanes. Do not let a heartbeat broaden authority for external writes, merges, deployments, or destructive actions.
