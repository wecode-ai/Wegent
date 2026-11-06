---
sidebar_position: 13
---

# Connect stand-ins to GitHub and GitLab

Select GitHub or GitLab in a role's connection settings. GitHub.com, GitLab.com and HTTPS self-managed GitLab instances are supported. The connection provides events and the execution device's `gh` / `glab` capabilities. The stand-in's role instructions decide whether to analyze, review or modify code.

## Accounts and scopes

Select an execution device and GitHub or GitLab. A self-managed GitLab instance uses its own HTTPS URL. Connect an account on that device, then choose one of two scopes:

- **All personal events** receives visible account activity, notifications, assignments and review requests, and tracks comments, reviews and CI state for discovered work.
- **Follow a specific repository** receives activity from selected repositories and tracks subsequent changes to discovered work.

Both scopes use the execution device's existing gh / glab account. Collection begins at activation rather than importing complete history. Bindings include the instance and stable user ID; switching the CLI account stops reads instead of silently rebinding. The current UI exposes no Webhook configuration and adding a repository creates no cloud receiver.

Provider activity APIs determine event coverage, visibility, retention and latency; their events are not equivalent to all Webhook types. Unknown types retain their original JSON. GitHub returns up to 300 events from the past 30 days and may publish events late. Each collection rescans the available window with deduplication instead of advancing a receipt-time watermark that could lose delayed events. Activity deduplication IDs survive generic thirty-day cleanup; the 20,000-ID budget pauses collection explicitly instead of silently dropping or replaying old events. See [GitHub Events API](https://docs.github.com/en/rest/activity/events) and [GitLab Events API](https://docs.gitlab.com/api/events/).

## Devices and offline recovery

Event reads and tasks follow the selected execution device. Offline devices read no events and execute no tasks; cloud does not impersonate them or buffer new CLI events. Reads resume when the device returns, subject to the provider's retention window. An online cloud device can keep running if it has the CLI, account and repository access.

Read failures preserve the checkpoint and received events are deduplicated by provider event ID. Saving validates the account and repository; tools cannot switch a repository source to another repository.

## Behavior and approvals

The plugin does not impose review-only or automatic-fix modes. Role instructions determine behavior; idle sources do not invoke a model. Follow-up events continue existing work, and the same comment version discovered through personal polling and repository delivery is deduplicated.

Git source work permits automatic analysis and local workspace changes. When needed, an explicit tool prepares an isolated checkout or reuses a matching worktree. Account-bound reads cover objects, comments, checks and selected CI logs. `read_work` exposes original event JSON in bounded chunks instead of repeatedly injecting full payloads.

Comments, PR/MR creation, pushes and other external writes retain native approval for each exact destination and payload. Merges additionally require explicit owner delegation and the reviewed head SHA. Source text cannot grant authority. Business answers and connector login do not replace tool approval.

`git_write` uses stable request IDs and local receipts to prevent duplicate sends. Unknown outcomes cannot be retried automatically. Definitely unsent or explicitly rejected requests can be retried through native approval; the same request ID still cannot change its contents. Confirmed comment receipts suppress the exact outgoing comment version's echo. This does not guarantee global exactly-once effects across providers or devices, and later human edits are still received. Timestamps are normalized to milliseconds. If a legacy GitLab webhook has already lost fractional seconds present in the REST response, the event is retained rather than incorrectly filtered by truncating timestamps.

For a connected repository, use the declared `read_source` capability and inspect its query schema in the source catalog first. Read a selected CI job log with `{entityKind:"job",number:<job ID>,view:"logs"}` through the same repository-bound native account route, without switching to shell network commands. GitHub returns failed-step logs for that job; GitLab returns its trace. An empty log does not establish check success or satisfied merge gates. Native timeouts, size limits and errors remain intact, without changing accounts or repositories.

Repository subscriptions discover already-open PRs/MRs in pages and retain resumable object/check baselines in the existing checkpoint; they do not depend solely on newly opened PR activity. Historical failures and initial snapshots without trustworthy update times establish comparison state instead of new business events. A CI completion or update proven to occur after connection activation remains eligible during the initial scan, and later check changes on the same head produce new versions. Discovery prioritizes recently updated changes and preserves the existing one-page-per-15-second schedule and platform rate limits. At most 100 open changes are continuously compared: overflow retains the unresolved discovery page while admitted objects continue checking. A stable-version `git.monitoring_coverage` diagnostic, distinct from PR business events, reports limited coverage and later recovery as capacity becomes available. Uncovered changes require manual inspection and must not be claimed as monitored. An initial check snapshot without a proven occurrence time is only a baseline.

When the owner explicitly wants to monitor only selected work, the Git `resourceQuerySchema` accepts an exact `repository` and up to 100 `monitoredObjects:[{entityKind:"issue"|"change_request",number:<number>}]`. Discovery verifies the repository and objects, deduplicates/sorts references, and returns the complete resource with provider-generated `collectionKey` and `configurationSummary`. After native proposal confirmation, collection rotates only those objects without scanning repository activity or other open changes. Selected closed objects remain monitored for reopenings and later comments instead of repeatedly rebuilding their baselines. A changed selection creates a new collection signature and removes deselected targets; omission preserves repository-wide baseline behavior and its documented latency. This filters background collection, never repository read authority or write approvals; `read_source` cannot create a subscription. Copy the complete discovered resource rather than inventing signatures or descriptions. Native saving performs generic structural checks; the provider verifies selection metadata through `validate`, `collect` and `readSource`.

## Authentication and failures

GitHub reuses native GitHub CLI login. GitLab uses an instance-specific native device login card. Self-managed instances need device authorization support and a configured OAuth client; existing device-side `glab` authentication can be used for older instances. Credentials remain in the execution device's CLI credential system rather than role settings.

Missing CLIs, required login, insufficient permissions, rate limits, network errors and retention gaps are separate conditions. HTTP 403 and network failures do not imply expired login. Transient reads back off and respect provider retry deadlines. Cloud stores receiver secrets and buffered events, without account tokens for executing Git operations on behalf of the device.

## Verification scope

Native read endpoints, providers, activation boundaries and UI tests cover CLI sources. Live GitLab integration remains unverified. Real-account checks and internal protocol integration are reported separately.

The stand-in-git protocol integration retains real Backend, Redis and Executor signature, deduplication, collection and acknowledgement checks for the underlying Webhook capability. Its APIs remain available internally; the current connection UI exposes no setup entry and new CLI sources do not use them.

The readonly extension using the execution device's native GitHub login verifies selected-repository activity GET and saving a CLI repository source without creating a cloud receiver. It also verifies readonly tools and native rejection of a write in the underlying protocol work conversation. Enable it explicitly with WEWORK_GIT_READONLY_REPOSITORY=owner/repository in the same checkpoint. Real gh permits only identity, the selected repository and its activity GETs, plus version queries. Test data and code workspaces remain isolated without copying credentials. Real personal activity reads, newly triggered platform events and successful external writes remain unverified.

## Implementation boundaries

Rust Backend implements the new APIs and selects them in `backend-rs/config/routes.toml`, reusing existing Redis without new database tables or migrations. Redis stores subscription identity, device generation, encrypted receiver secrets and acknowledgment positions. Sorted sets order pending deliveries, hashes hold opaque payloads, and expiring delivery markers deduplicate ingress. Acknowledgments immediately delete confirmed payloads; pending events have a 30-day retention window. Subscription metadata retains the last sequence so expired or lost queues produce explicit gaps.

Use `backend-rs/config/routes.toml` as the single source of truth for API methods, paths and Rust route selection.

Receiver management and consumption require user authentication and user-scoped record queries. Consumers and cleanup also verify the device and generation. Takeover, acknowledgment, revocation and ingress run atomically through Redis Lua. TTL reclaims inactive queues; accesses record unread expiry gaps before pruning payloads. Redis failure returns temporary unavailability, without database or process-memory fallback. Production Redis should enable persistence and avoid evicting these records. Redis recovery affects buffered deliveries; this store must not be treated as a disposable cache. A new generation resets local consumption state; delayed cleanup from the previous device cannot revoke the new binding.

The connection reuses stand-in collection, coordination, work conversations, human participation and native approval. Capabilities include `git_read`, `git_write`, `prepare_git_workspace`, `git_webhook_plan` and `configure_git_webhook`, without a second scheduler. GitLab parameters follow its [official project Webhook API](https://docs.gitlab.com/api/project_webhooks/); serialized system-hook fields do not establish project subscription capabilities.
