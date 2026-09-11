---
sidebar_position: 27
---

# Plugin and Smart App telemetry

Audit date: September 10, 2026. Existing PostHog connectivity is confirmed by the operator. This change repairs client coverage and event semantics; local tests are not proof of production ingestion.

## Contract

`wework/src/telemetry/registry/` generates the TypeScript allowlists and public JSON/Markdown catalogs. There are 36 plugin and 35 Smart App events. See `wework/telemetry/catalog/public-events.md` for names and failure stages.

| Area                             | Coverage and success boundary                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin navigation and management | Marketplace/management visits, toggles and uninstall retain existing names with consistent local/cloud source. Copy, ZIP import, delete, sharing, withdrawal and update policy report operation results.                                                                                                                                         |
| Plugin installation              | Request acceptance is distinct from device installation. Only the matching device and release in installed state emit device success and `plugin_installed`. Pending is not success; failed is a confirmation failure.                                                                                                                           |
| Plugin creation and publication  | Creation means task submission. Publication request/revision acceptance is separate from confirmed approval. Pending approval is not published success.                                                                                                                                                                                          |
| Plugin authorization and trial   | Local auth and cloud OAuth report completion, with cancellation silent. Disconnect reports its result. Trial means preparing an example, not executing a tool.                                                                                                                                                                                   |
| Automatic updates                | An update or repair batch reports success/failure; an idle poll is silent. This is not a per-plugin final device-version metric.                                                                                                                                                                                                                 |
| Smart Apps                       | Existing visits, install, update and ZIP import remain. Resolved failed installations are failures. Create, copy, link, export, share, uninstall, start/stop, configure, verify and add-plugin report at shared API boundaries. Start requires running, verify requires passed, and installation-producing operations require installed/running. |
| Smart App publication            | Accepted requests and confirmed publication are separate. Only immediately observed published/rejected responses emit final publication outcomes.                                                                                                                                                                                                |

Device confirmation tracks requests observed in the current client session, bounded to 100 pending entries, without persistence across restart. It is not a complete backend installation ledger. Later asynchronous approval is not counted unless observed by the publishing operation. Actual tool invocation, generation completion, latency and cancellation funnels require executor facts or a separate contract; visits, trial and task submission cannot establish them.

## Distribution and privacy

Business code publishes typed observations or operation results through `TelemetryAgent`. Public builds retain consent and the PostHog SDK. Internal builds deliver to internal sinks only. Observer errors cannot change business outcomes, and cancellation or duplicate terminal notifications do not produce extra results.

Public properties are allowlisted enums such as domain, failure_stage, source, scope, surface and enabled. Names, resource IDs, paths, account data and raw error text are excluded. Anonymous installation identity is not authenticated-account UV; public data cannot rank named individual plugins.

The packaging workflow maps existing `WEWORK_POSTHOG_KEY` and `WEWORK_POSTHOG_HOST` secrets to Vite variables. Catalog synchronization updates definitions rather than collecting events; a skipped synchronization job is not evidence of broken ingestion.

## QA plan

Use an isolated worktree and Electron home, real local backend, synthetic plugins/Smart Apps and a local PostHog receiver. Do not automate a personal application window.

1. Verify pending, failed, matching device/release, duplicate notification and explicit retry installation outcomes.
2. Exercise API resolution, rejected requests and resolved failure states. Preserve original errors; throwing telemetry observers cannot break operations.
3. Check OAuth/local authorization success, cancellation and failure with no private account/error fields.
4. Test safe public projection, internal-only delivery, declined/revoked consent and independent retries.
5. Run CI-owned `plugin-marketplace-lifecycle`: marketplace navigation and ZIP import must reach the receiver, alongside existing real installation/update/uninstall cleanup.
6. Run CI-owned `harness-apps`: create/install/start/stop/export/share/uninstall and publication-dialog cancellation, asserting receiver events and forbidden-property absence alongside existing recovery coverage.
7. Independently launch `ai:verify`, inspect the snapshot, navigate plugin and Smart App entries, retain final evidence and stop the isolated session to remove auth links.

Record actual local and CI results in the PR. After deployment, compare actual operations with events in the target PostHog project filtered by the new version. Old and corrected installation/creation semantics must not be combined without accounting for the change.
