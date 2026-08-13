# Backranq repository instructions

## Repository workflow skill

- For every task in this repository, invoke and follow
  `$backranq-orchestrator` from
  `.agents/skills/backranq-orchestrator/SKILL.md`.
- Use its solo mode for small or tightly coupled tasks; do not spawn agents
  merely because the skill is active.
- Skill activation does not broaden authority for external writes, destructive
  actions, commits, pushes, pull requests, merges, or deployments.

## Product idea capture

- `/Users/adam/dev/backranq/ideas.md` is the single untracked backlog shared by
  the canonical checkout and every Backranq worktree for product, UX, growth,
  distribution, and marketing ideas worth preserving before they become
  committed implementation work.
- When the user explicitly calls something a good idea, asks to remember or note
  it, or clearly approves it for future consideration, append or refine
  `/Users/adam/dev/backranq/ideas.md` in the same task without requiring a
  separate request or confirmation. Do not create a worktree-local ideas file.
- Avoid duplicate checklist items. Refine or extend the existing item when the
  idea is already represented, and preserve useful constraints or rationale
  needed to understand the intended outcome.
- Add new ideas as unchecked checklist items. Check them only when the
  user-facing outcome has been implemented and verified.
- Do not treat casual brainstorming, rejected alternatives, or an entry in the
  idea backlog as authorization to implement the idea.

## Product stage and production policy

- Backranq is currently a pre-user product. The deployed environment is not a
  real user production system and contains no user data that must be preserved.
- Do not implement or preserve backward compatibility. Prefer the clean target
  contract, schema, API, and UI even when that deliberately breaks old local or
  deployed state.
- Do not add compatibility aliases, legacy readers, dual reads/writes, data
  backfills, feature flags, staged rollouts, canaries, or deprecation periods
  unless the user explicitly asks for one.
- Database migrations may remove or reshape obsolete pre-user data instead of
  carrying it forward. Keep destructive operations precisely scoped and
  reviewable, but do not retain legacy structures merely to preserve existing
  records.
- Once the requested change passes proportionate code review and verification,
  it may be deployed directly to the production target. No rollout plan or
  production-user coordination is required at this stage.
- This policy removes compatibility and rollout requirements; it does not waive
  code review, tests, build validation, secret handling, or deployment health
  checks.

## Production deployment source

- The production deployment must always be built from the repository's `main`
  branch. Never deploy a feature branch, agent branch, or worktree branch
  directly to the production target.
- When the user asks to deploy work that currently exists only on a feature
  branch, follow the normal integration path first: review and verify the
  change, merge it into `main`, confirm that `main` contains the intended commit,
  and only then deploy that exact `main` commit to production.
- A request to "deploy to production" authorizes the production deployment
  workflow, not bypassing `main`. If merging or updating `main` is blocked by
  conflicts, failed checks, missing permissions, or ambiguous scope, stop and
  ask the user instead of deploying the feature branch.
- Before and after a production deployment, verify and report both the source
  branch (`main`) and deployed commit SHA. Also verify that the production
  project's configured Git branch remains `main` when the hosting provider has
  such a setting.
- Feature-branch deployments are allowed only as preview or test deployments
  when the user explicitly requests a preview/test deployment; they must never
  be promoted or described as production.
