---
sidebar_position: 1
---

# AI Runbook: Split Rust Migration Deliveries

Use this runbook when a migration branch changes the open-source Rust backend,
internal code, and traffic E2E configuration. This is an AI operating
procedure: follow the path rules exactly and let the splitter script, not AI
judgment, determine file ownership.

## Fixed delivery boundaries

| Delivery | Paths | Target |
| --- | --- | --- |
| Public | `backend-rs/**`; `backend/**`, excluding `backend/wecode/**` | A PR to `main` in `Wegent-github` |
| Internal | `backend/wecode/**`; `backend-rs-intra/**`, excluding `backend-rs-intra/.traffic-e2e/**` | An MR to `develop` in `Wegent-intra` |
| Traffic delivery | `backend-rs-intra/.traffic-e2e/**`; `.gitlab-ci.yml`; `wecode/docker/backend_migration/**` | One new commit on the current migration branch |

Treat every other changed path as ignored for this delivery round. The splitter
restores ignored paths to the internal base. Do not include them in the public
PR, internal MR, or final migration branch.

## Mandatory AI behavior

1. Never reclassify a file based on its name, contents, or apparent purpose.
   `split_migration_delivery.py` is the sole authority for path assignment.
2. Run `plan` before proposing or performing a split. Review the generated
   manifest, three patches, and ignored-path list.
3. Stop and ask for direction if an ignored path should be delivered, a
   rename/copy crosses path boundaries, a patch cannot apply, or the generated
   plan does not match this runbook.
4. Draft PR/MR titles, descriptions, risk notes, and test notes only from the
   corresponding patch and manifest section.
5. Do not push, create, update, approve, or merge a PR/MR without explicit
   user authorization.

## Preconditions

Before `apply`, ensure all of the following are true:

- The source branch, normally `dev-migration`, is checked out and clean.
- `origin/develop` in `Wegent-intra` and `origin/main` in `Wegent-github` are
  current.
- Both repositories have clean worktrees and configured Git author identity.
- The selected `--output-dir` does not exist yet. It will contain patches and
  an auditable `manifest.json`.

## 1. Plan

Run this from the `Wegent-intra` root:

```bash
uv run python backend-rs-intra/scripts/split_migration_delivery.py plan \
  --source dev-migration \
  --base origin/develop \
  --github-repo ../Wegent-github \
  --github-base origin/main \
  --output-dir /tmp/wegent-migration-handoff
```

Before continuing, verify that:

- the public, internal, and traffic-delivery paths match the fixed boundaries;
- every ignored path is intentionally omitted this round;
- the public patch contains no internal knowledge, dependencies, or
  configuration;
- the public patch is tested on its public base.

Every patch is checked for trailing whitespace before `apply` creates a branch
or rewrites the source branch.

### Mandatory public-export review

Before applying or publishing the public patch, AI must review only
`public.patch` and the corresponding files in the public worktree for:

- company or internal-product identifiers, including case-insensitive matches
  for `wecode`, `weibo`, and `sina`;
- internal hostnames, IP addresses, registries, service names, credentials, or
  environment-specific configuration;
- credentials or credential-shaped values, including passwords, secrets,
  tokens, API keys, authorization headers, private keys, and connection URLs.

Use focused searches and an available secret scanner where possible. Any match
is a user-confirmation gate: AI must report the matching file, line, and a
safe description of the value, then wait for explicit user confirmation before
applying or publishing the public patch. The sole pre-approved exception is
`Weibo` in an SPDX copyright or license declaration; report it, but it does
not require confirmation. Never include actual credentials in a PR description,
manifest, terminal output, or chat.

A rename or copy that crosses delivery boundaries intentionally makes the
script fail. Do not bypass the failure; split the change manually first.

## 2. Apply

After the plan has been reviewed and branch names have been selected, run:

```bash
uv run python backend-rs-intra/scripts/split_migration_delivery.py apply \
  --source dev-migration \
  --base origin/develop \
  --github-repo ../Wegent-github \
  --github-base origin/main \
  --github-branch feature/migration-public \
  --intra-branch feature/migration-intra \
  --intra-worktree ../Wegent-intra-migration-intra \
  --output-dir /tmp/wegent-migration-handoff
```

`apply` performs the following local-only operations:

1. Creates a public PR branch and commit in `Wegent-github` from the public
   patch.
2. Creates an internal-MR branch and commit in the supplied, retained
   `--intra-worktree`, based on `develop`.
3. Creates a backup branch for the original source branch.
4. Rebuilds the checked-out source branch with `reset --soft` from `develop`,
   removing every public, internal, and ignored change from that branch.
5. Applies and commits the traffic-delivery patch, including the E2E, GitLab
   CI, and migration-image paths from the table above.
6. Restores public and ignored paths to their internal-base versions.

The internal MR worktree remains available for review and for pushing its MR
branch. The primary `Wegent-intra` checkout remains on `dev-migration`.

The resulting local topology is:

```text
origin/develop
├─ internal MR commit (feature/migration-intra, in its own worktree)
└─ traffic-E2E commit (dev-migration)
```

The command does not push branches or open reviews.

## Recovering a failed local apply

Do not rerun `apply` after it has created branches. Use `rollback` instead:

```bash
uv run python backend-rs-intra/scripts/split_migration_delivery.py rollback \
  --source-branch dev-migration \
  --backup-branch backup/dev-migration-before-migration-split-<timestamp> \
  --github-branch feature/migration-public \
  --intra-branch feature/migration-intra \
  --intra-worktree ../Wegent-intra-migration-intra
```

`rollback` runs only when the temporary public and internal branches have not
been pushed, and when the source worktree contains no changes outside a failed
traffic-delivery patch. It restores the source branch from the backup, deletes
the two local delivery branches, removes the internal-MR worktree, and
preserves the backup branch. Fix the reported problem, choose a fresh output
directory, then run `plan` and `apply` again.

## 3. Review and publish

Use the manifest and patches to prepare one public PR targeting GitHub `main`
and one internal MR targeting `develop`. Keep their summaries, risk notes, and
test scopes separate.

Push or create reviews only after explicit authorization. The migration branch
history is rewritten, so publish it with `--force-with-lease`; never use an
unprotected force push.

`backend-rs-intra` can depend on public APIs introduced in the same delivery.
Until the public PR is merged and synchronized into internal `develop`, the
stripped migration branch may not build completely. Do not use it as the final
E2E verification branch during that interval.

## Start of the next migration round

After the public PR has merged and synchronized into internal `develop`, and
the internal MR has merged:

```bash
git fetch origin
git switch dev-migration
git rebase origin/develop
git push --force-with-lease origin dev-migration
```

At that point `develop` contains the synchronized public code and the internal
migration code. The rebase should leave only the traffic-E2E commit. If a
conflict occurs, first determine whether upstream already has an equivalent
change; do not reintroduce already delivered public or internal files.
