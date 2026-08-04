---
sidebar_position: 3
---

# Publishing Plugins

## Package layout

A plugin directory must contain a manifest. Add only the component directories
used by the plugin.

```text
<plugin-directory>/
  .codex-plugin/plugin.json
  skills/
  commands/
  agents/
  hooks/
  assets/
```

The manifest must provide a stable name and semantic version. Interface metadata
should include a concise display name and description.

Do not package credentials, `.env` files, session data, private keys, symbolic
links, encrypted ZIP members, duplicate paths, or files that escape the package
root. The scanner rejects unsafe packages.

## Publish a first-party plugin

Run all Python commands through `uv` from `backend/`.

```bash
cd backend

uv run python scripts/publish_official_plugin.py \
  <plugin-directory> \
  --slug <plugin-slug> \
  --listing-type plugin \
  --visibility public \
  --dry-run
```

The dry run builds and scans the package without writing storage or database
state. Publish after reviewing the output:

```bash
uv run python scripts/publish_official_plugin.py \
  <plugin-directory> \
  --slug <plugin-slug> \
  --listing-type plugin \
  --visibility public \
  --created-by-user-id <user-id> \
  --commit-sha "$CI_COMMIT_SHA" \
  --build-url "$CI_JOB_URL" \
  --publisher release-bot
```

Use `--visibility workspace` for a deployment-wide internal catalog. Use
`--listing-type skill` only for a single-skill package.

The command is idempotent for the same plugin, version, and checksum. Increase
the manifest version before publishing changed content.

## Seed a public catalog

Deployments that maintain a reviewed first-party plugin repository can seed all
public plugins with:

```bash
cd backend
uv run python scripts/seed_wework_public_plugins.py --dry-run
uv run python scripts/seed_wework_public_plugins.py
```

Use `--plugins-dir` or the script's documented environment variable when the
source repository is not in the default sibling directory.

## Configure an upstream mirror

Upstream mirrors are for explicitly reviewed third-party sources. Do not use
them for local or first-party plugin directories.

The included OpenAI GitHub example can be configured with:

```bash
cd backend
uv run python scripts/configure_openai_github_mirror.py
```

Require manual review when the upstream or adapter needs additional oversight:

```bash
uv run python scripts/configure_openai_github_mirror.py \
  --sync-policy review_required
```

General upstream management is available through the administrator plugin API.
Only HTTPS URLs resolving to public addresses are accepted. Review licensing,
provenance, package structure, and update behavior before enabling scheduled
synchronization.

## Review a submission

Administrators can use the review script for queued submissions:

```bash
cd backend
uv run python scripts/review_plugin_submission.py \
  approve \
  --submission-id <submission-id> \
  --reviewer-user-id <user-id> \
  --note "Reviewed source and scan report"
```

Reject a submission when its provenance, permissions, licensing, or behavior is
unclear. Do not approve a release that did not pass scanning.

## Release checklist

- The manifest name and slug are stable.
- The version follows semantic versioning and has not been reused.
- The source revision was reviewed.
- The dry run passes.
- No sensitive or generated local files are present.
- Visibility matches the intended audience.
- External services and authentication requirements are documented by the
  plugin itself.
- Installation and one representative workflow were verified on a clean device.
