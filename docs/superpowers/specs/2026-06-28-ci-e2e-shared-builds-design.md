---
sidebar_position: 1
---

# CI E2E Shared Builds Design

## Context

The `E2E Tests` GitHub Actions workflow currently builds the same frontend
application in every browser/API shard and again in the dedicated executor E2E
job. The executor E2E job also builds the ClaudeCode executor Docker image and
extracts the local executor binary inside the same long-running test job.

Recent successful PR baseline from PR #1581:

| Job | Approximate duration |
| --- | --- |
| `E2E Tests (Shard 1/4)` | 5m 11s |
| `Executor E2E Tests` | 7m 49s |

The exact baseline is taken from GitHub Actions job log first and last
timestamps because the available job-step API only returns step names.

## Goals

- Build the production Next.js frontend once per workflow run.
- Build the ClaudeCode executor E2E image and extracted binary once per
  workflow run.
- Keep ordinary E2E shards parallel and isolated.
- Keep executor-heavy coverage in the dedicated executor E2E job.
- Compare the PR run against the same E2E workflow baseline after the PR checks
  complete.

## Non-goals

- Do not merge all E2E tests into one shared-service job. GitHub hosted runners
  do not share local processes or Docker networks across jobs, and one large job
  would reduce test isolation.
- Do not convert Python virtual environments or `node_modules` into artifacts.
  Existing cache keys already cover dependency reuse, and virtualenv artifacts
  are more fragile than lockfile-backed installs.
- Do not change Playwright test selection or shard counts.

## Chosen Approach

Use build-artifact fan-out:

1. Add `build-frontend-e2e` to install frontend dependencies, run the existing
   production Next.js build once, archive the resulting runtime files, and upload
   a single artifact.
2. Add `build-executor-e2e-runtime` to build
   `wegent/e2e-claudecode-executor:latest`, extract
   `executor/target/release/wegent-executor`, save the Docker image to a tar
   archive, and upload both as one runtime artifact.
3. Make ordinary E2E shards depend on `build-frontend-e2e`, download the
   frontend artifact, restore it, and skip `next build`.
4. Make executor E2E depend on both build jobs, restore the frontend artifact,
   load the Docker image artifact, restore the binary, and skip both local
   builds.

This keeps service startup and databases per job while sharing immutable build
outputs between jobs through GitHub Actions artifacts.

## Artifact Layout

`build-frontend-e2e` creates:

- `.ci-artifacts/frontend-next-build.tar.zst`

The tarball includes:

- `frontend/.next` without `.next/cache`
- `frontend/public`

`build-executor-e2e-runtime` creates:

- `.ci-artifacts/e2e-claudecode-executor-image.tar.zst`
- `.ci-artifacts/wegent-executor`

The image tar is loaded in the executor job with the same tag expected by
`EXECUTOR_IMAGE`.

## Failure Handling

- Upload steps use `if-no-files-found: error` so a broken archive step fails
  before test jobs start.
- Restore steps verify required files after extraction or Docker load.
- Existing failure artifacts for Playwright traces and service logs remain
  unchanged.

## Validation

Local validation:

- Parse workflow YAML.
- Run shell syntax checks for any helper scripts.
- Inspect `git diff` for unintended workflow changes.

Remote validation:

- Push the branch and open a draft PR.
- Wait for GitHub Actions checks.
- Compare the new PR's `E2E Tests` workflow durations against the recent PR
  baseline above, with particular attention to ordinary shard jobs and
  `Executor E2E Tests`.
