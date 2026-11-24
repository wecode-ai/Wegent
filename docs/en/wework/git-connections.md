---
sidebar_position: 13
---

# Connect stand-ins to GitHub and GitLab

<!-- ui-source: src/components/settings/GitHostingSettingsPage.tsx -->

## Global Git hosting and task status

Open **Settings → Coding → Git hosting**, confirm the execution device and provider, then use the page's detection or connection action. GitHub uses CLI authentication on that device, not merely a website login. **Show PR / MR status** controls automatic status updates in task and Issue lists. Disabling it neither closes nor merges requests and does not cancel event waits set by AI. This page's CLI availability checks are independent of the switch. GitHub and GitLab publish their results separately; a completed result and its installation or sign-in action remain available while the other check is pending. Focus mode hides this page.

Open **Environment** in a task conversation to inspect the current branch's PR/MR. Its status icon opens check results and connector synchronization status. The Environment panel also shows synchronization in progress, authorization requirements or synchronization errors while retaining the last successfully retrieved PR/MR state. For authorization or synchronization errors, use **Configure code hosting tools** in that panel to check configuration on the execution device, then refresh. Interface status and AI event waits share connector collection; refreshing the interface does not call the model.

For repository events, use **My assistants → role profile → connection sources → GitHub/GitLab**, not just the status switch. Distinguish missing CLI, sign-in, network and permission failures before choosing login or retry.

The branch name in Environment is a borderless interactive row. Select the name or its trailing arrow to open the branch picker. Branch and delivery actions share the other rows' left alignment.

<a id="device-git-configuration"></a>

## Repository access configuration and device sync

**Device Git configuration → Configure Git account** on the Git hosting page opens the current cloud connection's Web **Settings → Integrations → Git accounts**. These HTTP(S) repository credentials are separate from stand-in event sources and native `gh` login. Navigation is unavailable until the cloud Web address is resolved and the connection is available; the Backend address is never a substitute.

The clone dialog offers the same quiet action beside the repository URL. Device error rows on execution-environment pages and Git authentication error cards in conversations also offer **Configure Git account** for ClaudeCode cloud or remote devices. The link retains the exact repository domain and port, editing an existing matching account or prefilling a new one. No duplicate clone notice appears in the sidebar. Return to the original entry to retry; repository, branch and directory inputs remain intact.

To sync manually:

1. Configure the repository domain's account in Web Git accounts.
2. Return to **Settings → Coding → Git hosting → Device Git configuration** and select **Refresh**.
3. Choose an online ClaudeCode cloud or remote device, then select **Sync Git configuration**.

Only the first effective account per domain in configuration order is synced. Success does not prove repository permission, branch availability or commit identity. Cloning and environment preparation first check actual device access; only HTTP(S) authentication failures trigger synchronization of existing accounts and one recheck. Sync failures retain the original Git diagnosis and configuration action.

Account metadata and the device list load independently; a device-list failure does not hide loaded accounts. Failed refreshes retain existing data and selections for the same connection; use Refresh to retry. Switching cloud accounts or connections requires selecting the target again; prior results and clear confirmations do not carry over.

Clearing is independent: when there are no effective cloud accounts, ordinary sync is disabled. Select a target, choose **Clear Wegent Git configuration**, and confirm to remove that device's managed configuration. Empty accounts, refreshes and authentication failures never clear it automatically or alter native local configuration.

Local devices use existing Git, credential managers and SSH configuration, including `core.sshCommand`, `GIT_SSH` and `GIT_SSH_COMMAND`. Repair SSH keys on the selected device rather than opening HTTP(S) accounts. Network, TLS, SSH host trust and 403/404 permission errors do not prove expired login. See [Git projects](../wegent/user-guide/coding/git-workspace-projects.md#configuration-and-recovery) for cloning and recovery.

## Stand-in event sources

Select GitHub or GitLab in a role's connection settings. GitHub.com, GitLab.com and HTTPS self-managed GitLab instances are supported. The connection provides events and the execution device's `gh` / `glab` capabilities. The stand-in's role instructions decide whether to analyze, review or modify code.

## Accounts and scopes

Select an execution device and GitHub or GitLab. A self-managed GitLab instance uses its own HTTPS URL. Connect an account on that device, then choose one of two scopes:

- **All personal events** receives visible account activity, notifications, assignments and review requests, and tracks comments, reviews and CI state for discovered work.
- **Follow a specific repository** receives activity from selected repositories and tracks subsequent changes to discovered work.

After choosing **Read signed-in account** or **Search repositories**, the results area shows progress. A successful empty result explains whether to check sign-in or adjust the search. Changing the instance, scope or query clears the previous feedback. Loading another page keeps the repositories already found.

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

The local executor stores conversation event consumers, observer leases, and collector state as individual records in `runtime-work/conversation-event-subscriptions.sqlite`. Task waits, sources, and cloud subscriptions use indexed queries; ordinary state notifications do not parse other sources' event histories. Enumerating current consumers remains proportional to the returned results, and individual B-tree lookups are O(log n), not strictly O(1). This event-store change is incompatible with legacy storage: old JSON journals are neither read nor imported. The application declares data schema 2 while retaining readability of other schema-1 data. Rollback to an older application requires the existing explicit snapshot-restore flow instead of directly reading the new event state.

Consumer changes and source reference counts commit together. Each background pass reclaims at most 32 sources without consumers; activation or collection in progress defers reclamation to a later pass without waiting. Stopped leases retain only the minimal generation fence. Unacknowledged cloud stop intents and captured delivery batches remain durable. Active sources keep the existing 1,000-event history window. Reclaimed database pages are reused and incrementally released, so complete API payloads from historical sources do not accumulate permanently with browsing and restarts.

## Wait for an exact GitHub workflow run

Ask in a task conversation to wait for a main-branch build, supplying its run URL or letting AI resolve the intended run. AI reads current state first and reports immediately if complete; otherwise it discovers the exact repository `workflow_run` object and subscribes. The `monitoredObjects` number is the Actions run ID, not a PR number. The subscription pins the canonical run URL, run ID and commit SHA. Success, failure and cancellation resume the original conversation. If GitHub associates the run with a single open PR at the same commit, a merge conflict also resumes the conversation while the run is in progress. One successful job does not establish workflow completion.

Reruns share a run ID and differ by `run_attempt`; match that field when waiting for one specific attempt. A post-merge main build must use its merge commit, rather than PR head checks. Keep the execution device running. The host collects and deduplicates events without repeated model sleeps and queries. Permission loss retains the last snapshot with an explicit unavailable state.

A subscription can combine common `match` conditions with `$any` alternatives. Pin the PR URL and commit SHA, then wait for checks to pass or fail in one subscription. All common conditions and every condition within a selected alternative must match. There are at most 32 total pointer comparisons; nested alternatives are unsupported. Select **Wait condition** on the event status row in the task composer to expand the full effective condition below it. The task sidebar and composer read the same task subscription status. While the conversation is idle, the sidebar shows event waiting, received or monitoring error status. If an event arrives during execution and is still awaiting delivery, the sidebar shows the received indicator. Human input keeps priority when required.

When a subscription is armed, retained shared-collector events after its activation boundary remain eligible, so a run completing during setup is not skipped by the sequence baseline. Local and cloud paths share that boundary calculation. Earlier history is not replayed; later events retain the existing sequence, deduplication and durable-delivery flow.

When asked to merge a PR, publish a release, or verify a workflow, the agent subscribes to pending checks or runs required for that outcome, even when waiting is implicit.

For routine waits, prefer `git_wait` with a discovered source selecting one object, omitting `match`. When following up on PR check failures or conflicts, select the PR itself and use `merge`, including when the task must leave the PR open. A conversation reuses the active merge wait for the same PR or MR across head changes. Use the returned subscription key to cancel or refresh the wait. Supply exact `head_sha` for `checks` and `run`. The merge wait covers terminal checks, merge conflicts even with PENDING checks, and closed or merged PRs. One merge wait registers one subscription. The first failed shard, a merge conflict, or any other matching result wakes the conversation. Arm the next wait if follow-up still requires waiting. The task list and environment panel use the same PR status monitor and reuse the subscribed PR snapshot when it matches. `checks` waits only for check results; `run` waits for completion including cancellation. The host expands the predicate at registration. Local and cloud delivery store the same predicate and the UI displays it. PR and MR `checks` and `merge` waits also match the current state read after subscription, so a failure already present on the selected commit can wake the conversation. Handle known blockers immediately. A wake still requires checking reviews and protection rules; it is not merge authorization.

GitHub PR waits commit the summary independently. One GraphQL request reads the current account, repository identity, and PR status. While CI is pending, the local Executor refreshes the summary about every 15 seconds. To detect early failures, it starts reading individual checks shortly after the first summary for a new head and checks again about a minute after a complete scan. The saved summary remains available if the detail read times out. The task resumes when the observed status matches its wait condition.

Subscriptions wait for new changes after their activation boundary; they do not replay earlier history. A run completing between the initial state read and activation can otherwise be missed by an existing shared collector. Immediately read current state once more after arming; if satisfied, cancel the wait and handle the result. This confirmation is not a polling loop.

GitLab uses the same `git_wait: merge | checks | run` entry point. Select an MR by `change_request` and IID, or an exact pipeline by `pipeline` and pipeline ID, and supply the actual head SHA for `checks` and `run`. Merge waits include conflicts and closed/merged states; pipeline outcomes cover success, failed, canceled, skipped and manual action. Pipeline reads reuse the native repository API and validate project ID, run URL, pipeline ID, account and revision without another collector. Matching events use the existing message-send path and durable queue while busy, continuing the same conversation after execution ends. Human questions, approvals and user pauses remain protected.
