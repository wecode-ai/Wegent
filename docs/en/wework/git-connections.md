---
sidebar_position: 13
---

# Connect stand-ins to GitHub and GitLab

Select GitHub or GitLab in a role's connection settings. GitHub.com, GitLab.com and HTTPS self-managed GitLab instances are supported. The connection provides events and the execution device's `gh` / `glab` capabilities. The stand-in's role instructions decide whether to analyze, review or modify code.

## Accounts and scopes

Select the execution device, platform and instance, then connect the account on that device. Choose personal events or search and select multiple repositories. An account is bound to its instance and stable provider user ID. Switching the active CLI account stops reads instead of silently rebinding the source. Install the CLI on the execution device beforehand.

- **Personal events** poll notifications, assigned items and review requests, then track comments, reviews and CI state for discovered items. Initial activation starts at the activation time, without importing complete history. Provider visibility, query and search limits apply; this is not a repository audit stream.
- **Repository events** use provider Webhooks. Wework cloud verifies signatures and buffers deliveries until the selected device collects them. Original event types and JSON are preserved, including unknown types.

## Repository Webhooks

Repository additions and takeovers enter a profile draft first. Saving creates or takes over cloud receivers; discarding the draft changes nothing remotely. All new account and repository bindings are checked before mutations. After saving, use “Configure Webhook” beside the connection to reopen the callback URL and separately revealable secret. Secrets do not enter role settings or model context. Ask the stand-in to configure the Webhook, or configure it manually in the provider. Assisted configuration first reads a safe plan, then requires native approval for the exact instance, repository, callback and event selection.

GitHub uses all events (`*`). For GitLab, enable all project Webhook event flags supported by the selected instance version. Unsupported flags require explicit correction; a partial subscription must not be reported as complete. “All” means events the provider allows that repository to subscribe to, not unavailable system events. The provider must reach the cloud callback; private GitLab networks may need administrator configuration.

Automatic GitLab configuration reads the instance version first: milestone events are omitted before 18.2, and deploy-token events before 18.4. Plans and results list these limitations. Core and access-token events remain required; an unrecognized version stops configuration. Version eligibility does not prove delivery: deploy-token notifications in 18.4 also depend on an instance feature flag, so actual delivery still needs verification.

The UI shows the last received event, pending count and retention gaps. A generated callback alone does not prove provider setup succeeded; inspect provider delivery results and receiver status. Removing a connection and saving revokes the cloud receiver. Delete the provider-side Webhook separately.

## Devices and offline recovery

Work follows the selected execution device. An offline computer executes nothing while cloud buffering continues for repository Webhooks. The device collects pending events in order when it returns. An online cloud device can keep running if it has the CLI, account and repository permissions. Personal polling resumes on the execution device, without cloud impersonation.

Saving a takeover replaces the consumer device and generation. The old consumer cannot fetch, acknowledge or invoke Git tools through that connection. Consumption resumes from the confirmed position. If cloud changes succeed but local saving is interrupted, the UI explicitly reports possible partial changes. Retry the draft or add an existing receiver on this device to recover. Delivery IDs deduplicate ingress, and acknowledgments advance only after local persistence. Deliveries are retained for up to 30 days, with a limit of 10,000 unconfirmed deliveries per subscription. Capacity exhaustion rejects ingress so failures remain visible at the provider. Expired pending deliveries create an explicit gap and stop automatic advancement until investigated. Inspect provider delivery records because providers may not automatically redeliver every failure.

## Behavior and approvals

The plugin does not impose review-only or automatic-fix modes. Role instructions determine behavior; idle sources do not invoke a model. Follow-up events continue existing work, and the same comment version discovered through personal polling and repository delivery is deduplicated.

Git source work permits automatic analysis and local workspace changes. When needed, an explicit tool prepares an isolated checkout or reuses a matching worktree. Account-bound reads cover objects, comments, checks and selected CI logs. `read_work` exposes original event JSON in bounded chunks instead of repeatedly injecting full payloads.

Comments, PR/MR creation, pushes and other external writes retain native approval for each exact destination and payload. Merges additionally require explicit owner delegation and the reviewed head SHA. Source text cannot grant authority. Business answers and connector login do not replace tool approval.

`git_write` uses stable request IDs and local receipts to prevent duplicate sends. Unknown outcomes cannot be retried automatically. Definitely unsent or explicitly rejected requests can be retried through native approval; the same request ID still cannot change its contents. Confirmed comment receipts suppress the exact outgoing comment version's echo. This does not guarantee global exactly-once effects across providers or devices, and later human edits are still received. Timestamps are normalized to milliseconds. If a legacy GitLab webhook has already lost fractional seconds present in the REST response, the event is retained rather than incorrectly filtered by truncating timestamps.

## Authentication and failures

GitHub reuses native GitHub CLI login. GitLab uses an instance-specific native device login card. Self-managed instances need device authorization support and a configured OAuth client; existing device-side `glab` authentication can be used for older instances. Credentials remain in the execution device's CLI credential system rather than role settings.

Missing CLIs, required login, insufficient permissions, rate limits, network errors and retention gaps are separate conditions. HTTP 403 and network failures do not imply expired login. Transient reads back off and respect provider retry deadlines. Cloud stores receiver secrets and buffered events, without account tokens for executing Git operations on behalf of the device.

## Verification scope

The `stand-in-git` desktop CI protocol integration scenario covers signature validation, deduplication, fetching, acknowledgment and takeover fencing through real Wework Backend, Redis and Executor services. It uses no real GitHub/GitLab account and does not establish live provider compatibility. Validate login, supported event flags, delivery and native write approval against the target instance before rollout.

On an execution device already signed in through `gh`, explicitly setting `WEWORK_GIT_READONLY_REPOSITORY=owner/repository` enables the same scenario's live GitHub read-only extension: read the repository with the real account, submit a signed event to the internal ingress while the device is stopped, resume collection and repository reads after restart, and reject native external-write approval. Only model responses are simulated. This extension does not install a provider Webhook or verify live personal-event polling or successful writes. Live GitLab account integration requires separate verification.

## Implementation boundaries

Rust Backend implements the new APIs and selects them in `backend-rs/config/routes.toml`, reusing existing Redis without new database tables or migrations. Redis stores subscription identity, device generation, encrypted receiver secrets and acknowledgment positions. Sorted sets order pending deliveries, hashes hold opaque payloads, and expiring delivery markers deduplicate ingress. Acknowledgments immediately delete confirmed payloads; pending events have a 30-day retention window. Subscription metadata retains the last sequence so expired or lost queues produce explicit gaps.

Use `backend-rs/config/routes.toml` as the single source of truth for API methods, paths and Rust route selection.

Receiver management and consumption require user authentication and user-scoped record queries. Consumers and cleanup also verify the device and generation. Takeover, acknowledgment, revocation and ingress run atomically through Redis Lua. TTL reclaims inactive queues; accesses record unread expiry gaps before pruning payloads. Redis failure returns temporary unavailability, without database or process-memory fallback. Production Redis should enable persistence and avoid evicting these records. Redis recovery affects buffered deliveries; this store must not be treated as a disposable cache. A new generation resets local consumption state; delayed cleanup from the previous device cannot revoke the new binding.

The connection reuses stand-in collection, coordination, work conversations, human participation and native approval. Capabilities include `git_read`, `git_write`, `prepare_git_workspace`, `git_webhook_plan` and `configure_git_webhook`, without a second scheduler. GitLab parameters follow its [official project Webhook API](https://docs.gitlab.com/api/project_webhooks/); serialized system-hook fields do not establish project subscription capabilities.
