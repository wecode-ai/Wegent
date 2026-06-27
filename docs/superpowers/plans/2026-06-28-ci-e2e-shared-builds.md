---
sidebar_position: 1
---

# CI E2E Shared Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build E2E runtime artifacts once per GitHub Actions run and share them across ordinary E2E shards and executor E2E.

**Architecture:** Add dedicated build jobs that upload immutable artifacts, then fan out isolated test jobs that download and restore those artifacts. Keep dependency caches and service containers per job.

**Tech Stack:** GitHub Actions, Bash, Docker CLI, Next.js 15, Playwright.

---

## File Structure

- Create `.github/scripts/archive-frontend-e2e-build.sh`: package `frontend/.next`
  and `frontend/public` into `.ci-artifacts/frontend-next-build.tar.zst`.
- Create `.github/scripts/restore-frontend-e2e-build.sh`: unpack the frontend
  artifact and verify `frontend/.next/BUILD_ID`.
- Create `.github/scripts/archive-executor-e2e-runtime.sh`: save the
  ClaudeCode executor image and extracted binary into `.ci-artifacts/`.
- Create `.github/scripts/restore-executor-e2e-runtime.sh`: load the Docker
  image, restore the local executor binary, and verify both outputs.
- Modify `.github/workflows/e2e-tests.yml`: add build jobs, download artifacts
  in test jobs, and remove duplicated build steps.
- Modify `frontend/e2e/README.md`: document that CI now uses shared production
  build artifacts.

### Task 1: Add artifact helper scripts

**Files:**
- Create: `.github/scripts/archive-frontend-e2e-build.sh`
- Create: `.github/scripts/restore-frontend-e2e-build.sh`
- Create: `.github/scripts/archive-executor-e2e-runtime.sh`
- Create: `.github/scripts/restore-executor-e2e-runtime.sh`

- [ ] **Step 1: Write helper scripts**

```bash
mkdir -p .github/scripts
```

Each script must start with `#!/usr/bin/env bash` and `set -euo pipefail`.

Frontend archive script:

```bash
artifact_dir="${1:-.ci-artifacts}"
mkdir -p "$artifact_dir"
test -f frontend/.next/BUILD_ID
tar --exclude='.next/cache' -I 'zstd -T0 -3' -cf "$artifact_dir/frontend-next-build.tar.zst" -C frontend .next public
test -s "$artifact_dir/frontend-next-build.tar.zst"
```

Frontend restore script:

```bash
artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/frontend-next-build.tar.zst"
test -s "$archive"
rm -rf frontend/.next
tar -I zstd -xf "$archive" -C frontend
test -f frontend/.next/BUILD_ID
```

Executor archive script:

```bash
artifact_dir="${1:-.ci-artifacts}"
image_tag="${2:-wegent/e2e-claudecode-executor:latest}"
image_archive="$artifact_dir/e2e-claudecode-executor-image.tar.zst"
mkdir -p "$artifact_dir"
docker image inspect "$image_tag" >/dev/null
docker save "$image_tag" | zstd -T0 -3 > "$image_archive"
test -x executor/target/release/wegent-executor
cp executor/target/release/wegent-executor "$artifact_dir/wegent-executor"
chmod 0755 "$artifact_dir/wegent-executor"
test -s "$image_archive"
test -x "$artifact_dir/wegent-executor"
```

Executor restore script:

```bash
artifact_dir="${1:-.ci-artifacts}"
image_tag="${2:-wegent/e2e-claudecode-executor:latest}"
image_archive="$artifact_dir/e2e-claudecode-executor-image.tar.zst"
binary="$artifact_dir/wegent-executor"
test -s "$image_archive"
test -s "$binary"
zstd -dc "$image_archive" | docker load
docker image inspect "$image_tag" >/dev/null
mkdir -p executor/target/release
cp "$binary" executor/target/release/wegent-executor
chmod 0755 executor/target/release/wegent-executor
test -x executor/target/release/wegent-executor
```

- [ ] **Step 2: Verify shell syntax**

Run:

```bash
bash -n .github/scripts/archive-frontend-e2e-build.sh
bash -n .github/scripts/restore-frontend-e2e-build.sh
bash -n .github/scripts/archive-executor-e2e-runtime.sh
bash -n .github/scripts/restore-executor-e2e-runtime.sh
```

Expected: all commands exit 0.

### Task 2: Add build jobs to E2E workflow

**Files:**
- Modify: `.github/workflows/e2e-tests.yml`

- [ ] **Step 1: Add `build-frontend-e2e` before test jobs**

The job checks out code, sets up pnpm and Node 24, restores frontend
`node_modules`, installs dependencies, restores the Next.js cache, runs
`pnpm exec next build`, archives the build, and uploads
`frontend-next-build`.

- [ ] **Step 2: Add `build-executor-e2e-runtime` before test jobs**

The job checks out code, builds `wegent/e2e-claudecode-executor:latest` with
the existing fixture Dockerfile, extracts `/app/executor` to
`executor/target/release/wegent-executor`, archives the Docker image and binary,
and uploads `executor-e2e-runtime`.

- [ ] **Step 3: Keep build jobs parallel**

Do not make either build job depend on the other.

### Task 3: Make ordinary E2E shards consume frontend artifact

**Files:**
- Modify: `.github/workflows/e2e-tests.yml`

- [ ] **Step 1: Add `needs: build-frontend-e2e` to `e2e-tests`**

- [ ] **Step 2: Replace `Cache Next.js build` and `Build frontend for E2E`**

Use `actions/download-artifact` to download `frontend-next-build` into
`.ci-artifacts`, then run `.github/scripts/restore-frontend-e2e-build.sh`.

- [ ] **Step 3: Leave service startup and Playwright sharding unchanged**

The shard matrix, MySQL/Redis service containers, backend startup, Chat Shell
startup, frontend `next start`, mock model server, and report upload steps stay
functionally equivalent.

### Task 4: Make executor E2E consume both artifacts

**Files:**
- Modify: `.github/workflows/e2e-tests.yml`

- [ ] **Step 1: Add `needs: [build-frontend-e2e, build-executor-e2e-runtime]`**

- [ ] **Step 2: Remove host Rust setup from test job**

Keep `Install executor Rust system dependencies` because the restored local
executor binary may still need runtime OpenSSL libraries on the Ubuntu runner.

- [ ] **Step 3: Replace frontend build steps**

Download and restore `frontend-next-build`, same as ordinary E2E shards.

- [ ] **Step 4: Replace Docker image build and binary extraction**

Download `executor-e2e-runtime` into `.ci-artifacts` and run
`.github/scripts/restore-executor-e2e-runtime.sh`.

- [ ] **Step 5: Leave executor service flow unchanged**

The local executor startup, executor-manager startup, Docker bridge environment,
and `executor-chromium` Playwright project stay functionally equivalent.

### Task 5: Update E2E README

**Files:**
- Modify: `frontend/e2e/README.md`

- [ ] **Step 1: Replace stale CI note**

Document that CI builds the frontend once in `build-frontend-e2e`, restores it
in each E2E test job, and builds the executor image/binary once in
`build-executor-e2e-runtime` for executor E2E.

### Task 6: Validate locally

**Files:**
- Validate: `.github/workflows/e2e-tests.yml`
- Validate: `.github/scripts/*.sh`

- [ ] **Step 1: Run script syntax checks**

```bash
bash -n .github/scripts/archive-frontend-e2e-build.sh
bash -n .github/scripts/restore-frontend-e2e-build.sh
bash -n .github/scripts/archive-executor-e2e-runtime.sh
bash -n .github/scripts/restore-executor-e2e-runtime.sh
```

- [ ] **Step 2: Parse workflow YAML**

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/e2e-tests.yml"); puts "ok"'
```

- [ ] **Step 3: Inspect diff**

```bash
git diff -- .github/workflows/e2e-tests.yml .github/scripts frontend/e2e/README.md docs/superpowers
```

### Task 7: Publish and compare CI

**Files:**
- Commit changed files.
- Push `codex/ci-share-e2e-builds`.
- Open a draft PR against `main`.

- [ ] **Step 1: Commit**

```bash
git add .github/workflows/e2e-tests.yml .github/scripts frontend/e2e/README.md docs/superpowers/specs/2026-06-28-ci-e2e-shared-builds-design.md docs/superpowers/plans/2026-06-28-ci-e2e-shared-builds.md
git commit -m "fix(ci): share e2e build artifacts"
```

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin codex/ci-share-e2e-builds
```

Open a draft PR titled `[codex] Share E2E build artifacts`.

- [ ] **Step 3: Verify PR checks and timing**

Use GitHub Actions run data for the PR head SHA. Compare `E2E Tests` workflow
ordinary shard duration and executor E2E duration against the PR #1581 baseline:

- `E2E Tests (Shard 1/4)`: 5m 11s
- `Executor E2E Tests`: 7m 49s

If the PR fails because of this workflow change, inspect the failed job logs,
fix the workflow, and rerun the checks.
