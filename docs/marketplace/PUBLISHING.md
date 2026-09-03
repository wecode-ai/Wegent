---
sidebar_position: 3
---

# Publishing Plugins

The application, review, and release code described here is implemented and
locally verified. Production rollout has not been approved or deployed. Because
there is no application-level publication switch, complete these prerequisites
before deployment: revoke and rotate the old token, use HTTPS or an approved
encrypted transport for the Release API, configure protected master/environment
and Code Owner approvals, verify project-locked native Windows and macOS Runners,
and provision a new protected Release credential.

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

## Choose the publication intent

Personal-plugin details expose one **Share** action. It opens the
**Share & publish** dialog. The first choice is the audience, not a publishing
permission:

- **Specific members or departments** uploads and scans the personal Release,
  then applies its user/department ACL. The organization root is represented by
  its root department. No administrator review is required.
- **Everyone in the enterprise** starts a governed `workspace` publication
  request. It does not make the personal plugin visible to everyone.

Ordinary users cannot request `public`. That scope remains available only to
approved official publication paths.

## Submit an enterprise publication request

Wework collects the application in three steps:

1. Show the current packageable personal version and collect required release
   notes (`1–2000` characters after trimming). Do not upload, scan, or freeze a
   server snapshot yet.
2. Collect the author's permission and risk declarations: external network
   domains, command/script execution, local-file access, credentials, application
   authorization, and required test notes (`1–1000` characters after trimming).
   Do not prefill facts derived from a package that has not been submitted.
3. Review the declarations and submit. Final submission uploads the package,
   creates the immutable revision, and records the server-computed package and
   source-tree SHA-256 values.

The request then reports five stages: **Submit request**, **Automated checks**,
**Administrator review**, **Code review**, and **Release**. Automated checks start
after final submission and before administrator review. The personal source
remains editable and shareable throughout the process. A return-for-changes or
deterministic content-check failure includes concrete findings; resubmission
creates a new revision in the same Request instead of replacing the previous
snapshot. Upload, transport, or infrastructure failure retries the same revision
idempotently. Only one Request may be active for a personal source. After a
Published Request is terminal, publishing a higher version creates a new Request
starting at revision 1.

Administrator acceptance creates a GitLab MR and records the accepted
revision. It is not publication approval. The administrator service must reject
acceptance when blocking findings remain or required warnings were not
acknowledged.

## Converge in GitLab

Non-technical authors submit through Wework; the backend materializes an accepted
immutable snapshot into a review branch and MR. Developers may create a
branch and MR directly in the internal plugin repository. From that point both
paths use exactly the same controls:

1. one version of one plugin per MR, followed by source and policy review;
2. package and risk checks;
3. native Windows compatibility checks;
4. native macOS compatibility checks;
5. protected-branch approval, followed by GitLab native auto-merge after the MR
   Pipeline succeeds;
6. deterministic publication from the protected `master` pipeline.

MR pipelines must not receive production release credentials. A GitLab webhook
may synchronize MR, pipeline, and merge state into the publication-request
timeline, and a scheduled reconciliation job may repair missed events, but
neither is an independent publication trigger.

For a Wework-created MR, the Backend registers auto-merge immediately after MR
creation with the exact materialized commit SHA. The controlled GitLab project
must enable **Pipelines must succeed**; otherwise materialization fails before
repository writes. Retrying the same accepted revision reuses the bound MR and
registers auto-merge again idempotently. Because GitLab may create the MR before
its Pipeline record is visible, the Backend waits for a same-SHA `head_pipeline`
and retries only a transient `405` from auto-merge registration with bounded
backoff.

After `code_changes_requested`, a developer fixes the existing controlled branch
and MR and reruns its Pipeline. A non-technical author does not create a
publication revision for code-review changes. If the accepted immutable snapshot
itself must change, end the current code-review flow and submit through a new
Request/Revision flow.

## Idempotent workflow mutations

Create Request, create Revision, complete Revision, withdraw, administrator
return, administrator accept, and administrator reconcile all require an
`Idempotency-Key` of `8–200` characters. The server persistently binds it to the
authenticated principal, operation, resource, and canonical payload fingerprint.
Keys may contain only `[A-Za-z0-9._:-]`.
The same key/resource/payload returns the original response; reusing the key for a
different resource or payload returns `409`; a duplicate still processing also
returns `409`. Reuse a logical attempt only for retrying that same operation after
a transport or infrastructure failure. Generate a new key for a new explicit
operation, including a later reconciliation.

## Protected master publication

The protected `master` release job packages the exact merged commit and calls the
backend release endpoint with:

```http
Authorization: Bearer <release-token>
```

`plugin_release` is a dedicated type in the existing Wegent API-key lifecycle,
not a new authentication system.
Administrators create one with `POST /api/admin/plugin-release-keys`, list keys
with `GET /api/admin/plugin-release-keys`, and disable or re-enable one with
`POST /api/admin/plugin-release-keys/{id}/toggle-status`. Creation takes a name,
optional description, and expiry. The GitLab project and target branch are
server-side publication configuration and are not stored on the key. The raw `wg-...` value is
shown once, only its hash is stored, and the value is saved as a protected and
masked GitLab CI variable. It cannot impersonate users or call ordinary APIs.
Rotate by creating and validating a replacement before disabling the old key.

The Release request also carries the exact header
`Idempotency-Key: wework-plugin-v1:<64hex>`. The server recomputes the digest from
the GitLab project ID, final commit SHA, and artifact SHA-256 and binds it to the
authenticated release-key record.

The backend rechecks the artifact checksum, manifest identity, semantic version,
package policy, and expected GitLab project/commit before publication. The target
catalog and `workspace` visibility are fixed server-side. Identical retries are
idempotent; the same version with different bytes is rejected. A failed release
does not move the existing enterprise `latest_release_id`.

## Break-glass first-party publication

Run all Python commands through `uv` from `backend/`.

```bash
cd backend

uv run python scripts/publish_official_plugin.py \
  <plugin-directory> \
  --slug <plugin-slug> \
  --listing-type plugin \
  --visibility workspace \
  --dry-run
```

The dry run builds and scans the package without writing storage or database
state. Only for an explicitly authorized break-glass release, run:

```bash
uv run python scripts/publish_official_plugin.py \
  <plugin-directory> \
  --slug <plugin-slug> \
  --listing-type plugin \
  --visibility workspace \
  --created-by-user-id <user-id> \
  --commit-sha "$CI_COMMIT_SHA" \
  --build-url "$CI_JOB_URL" \
  --publisher release-bot
```

This command is an operator break-glass path, not the standard enterprise
workflow. The CLI builds a deterministic package; the Release API receives the
CI artifact. Both use the shared parser/scanner primitives and marketplace
publication transaction, so HTTP never spawns the CLI and persistence logic is
not duplicated. A dry run only proves packaging and inspection; it does not
prove GitLab review, native Windows/macOS compatibility, or online publication.

Use `--listing-type skill` only for a single-skill package. Do not use
`--visibility public` for an employee publication request.

The command is idempotent for the same plugin, version, and checksum. Increase
the manifest version before publishing changed content.

## Public catalog and upstreams

The GitHub-based Wework official public catalog is a P1 product decision. Existing
public seeding and upstream support remain operational during migration, but they
are not part of the enterprise workflow and must not be presented as the final
GitHub design.

Deployments that already maintain a reviewed first-party public repository may
continue to use the existing operational command while that P1 decision remains
open:

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

Until the P1 GitHub design is approved, the temporary behavior is that GitHub is
**not** mirrored into the Wework domestic-public catalog; install the OpenAI
official marketplace plugin instead. For other reviewed upstreams, use the
administrator plugin API. Only HTTPS URLs resolving to public addresses are
accepted. Review licensing, provenance, package structure, and update behavior
before enabling scheduled synchronization.

## Legacy review path

The following legacy review script remains solely for historical
`PluginSubmission` rows:

```bash
cd backend
uv run python scripts/review_plugin_submission.py \
  approve \
  --submission-id <submission-id> \
  --reviewer-user-id <user-id> \
  --note "Reviewed source and scan report"
```

Its `approve` operation immediately publishes the Release. It must not be called
from the new Web administrator flow and must not be relabeled as “create an
MR.” Legacy `/plugins/submissions` now accepts only
`restricted_share + personal`; it cannot create a new enterprise request. Retain
the review command only while draining or migrating historical pending rows,
then remove it together with the old direct-review endpoint. New requests are
returned or accepted through the publication-request service; acceptance only
creates the MR.

## Release checklist

- The manifest name and slug are stable.
- The version follows semantic versioning and has not been reused.
- The request revision, source Release, and SHA-256 are immutable.
- Release notes and test notes satisfy the trimmed `1–2000` and `1–1000` limits.
- Every declared permission is consistent with the package evidence.
- Blocking findings are absent and administrator-confirmed warnings are audited.
- The accepted revision is the one materialized in the MR.
- Source review, risk checks, and native Windows/macOS checks pass for the exact
  commit being merged.
- The protected `master` job is the only automated release trigger.
- The release job uses a dedicated `plugin_release` key; MR jobs cannot read it.
- Workflow and Release calls use their required idempotency-key contracts.
- Webhook deliveries only synchronize/reconcile state and are replay-safe.
- No sensitive or generated local files are present.
- The backend fixes enterprise publication to `workspace`; ordinary requests
  cannot choose `public`.
- External services and authentication requirements are documented by the
  plugin itself.
- Installation and one representative workflow were verified on a clean device.
- A failed new release leaves the current enterprise version installable.
