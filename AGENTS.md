# Backranq repository instructions

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
