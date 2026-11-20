---
name: github
description: 'Read and change GitHub repositories, pull requests, issues and workflows with gh. Subscribe to pending GitHub checks and runs through Wework.'
---

Wework GitHub CLI mode:

- GitHub reads and writes in this host use the local `gh` CLI, not `codex_apps.github` or ChatGPT GitHub connectors. This host rule overrides connector-first instructions in installed GitHub skills, including older versions.
- Resolve the requested hosting provider from the user request and repository remote before checking authentication. GitLab operations and ordinary Git commit/push operations do not require GitHub authentication; never block them on a GitHub login check.
- Check `gh api user --silent --hostname github.com` before GitHub operations. A request to run `gh auth login` or HTTP 401 means login is required; network errors and HTTP 403 are not proof of missing authentication. Do not read auth files, print tokens, call `gh auth token`, or request tokens in chat.
- If gh is missing, tell the user to install GitHub CLI on the execution device. Do not install software without permission.
- If authentication is missing or invalid, stop GitHub operations and return `connector_auth_required`, `pluginKey=github`, and `connectorSlug=wework-github-cli`. Wework will offer a user-initiated GitHub login card and continue from the blocked operation after verification. Do not run an interactive login command inside an agent tool call.
- Network errors, missing repository permissions, and unsupported operations are not login success or reasons to switch to the official connector. Report the specific problem and keep the user's requested scope.
- Use `gh repo`, `gh pr`, `gh issue`, `gh run`, and `gh api` for supported operations. Repository listing can use `gh api user/repos --paginate --jq '.[] | {name: .full_name, url: .html_url}'`. Select the intended repository explicitly and require the usual user authorization for writes.

## Waiting for GitHub

A request to merge, release, or verify a workflow includes waiting for the required pending checks or runs. Use `gh` to identify the exact resource and read its current state. Handle an existing failure, merge conflict or completed run immediately.

1. Discover `wework_control.list_connection_event_providers` and `list_connection_event_resources`. Select one `change_request` by PR number for merge or check waits, or one `workflow_run` by Actions run ID for workflow completion. After merging, resolve the main-branch run and its own head SHA.
2. Call `subscribe_connection_events` with the returned source and `git_wait` set to `merge`, `checks`, or `run`. Merge waits follow the PR across head changes. A single merge wait covers the first failed shard, terminal checks, conflicts and PR closure or merge. After handling a result, arm a new wait if the PR still needs follow-up. Supply the full `head_sha` for `checks` and `run`. The host generates the predicate, so omit `match`. Set `wait_for_event: true` to suspend Goal continuation. Use a stable subscription key while the wait is active and describe what to do after wake in `continuation`. If the host reuses a wait, use its returned key to cancel or refresh it.
3. Confirm the wait is armed and read current state once to close the activation gap. If a condition is already actionable, handle it and cancel its wait if it is still armed. Otherwise finish the turn. The host watches for success, failure and other terminal outcomes. After every PR wake, read the check results and mergeability together and surface the observed failure or conflict. Verify reviews and branch protection before merging.

Use subscriptions for waiting. Do not use `gh run watch`, `gh pr checks --watch`, sleeps or repeated status queries. If discovery or activation fails, report the exact limitation.
