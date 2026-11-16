---
name: github
description: 'Read or change GitHub repositories, pull requests, issues or CI using the local gh CLI.'
---

Wework GitHub CLI mode:

- GitHub tasks in this host use the local `gh` CLI, not `codex_apps.github` or ChatGPT GitHub connectors. This host rule overrides connector-first instructions in installed GitHub skills, including older versions.
- Resolve the requested hosting provider from the user request and repository remote before checking authentication. GitLab operations and ordinary Git commit/push operations do not require GitHub authentication; never block them on a GitHub login check.
- Check `gh api user --silent --hostname github.com` before GitHub operations. A request to run `gh auth login` or HTTP 401 means login is required; network errors and HTTP 403 are not proof of missing authentication. Do not read auth files, print tokens, call `gh auth token`, or request tokens in chat.
- If gh is missing, tell the user to install GitHub CLI on the execution device. Do not install software without permission.
- If authentication is missing or invalid, stop GitHub operations and return `connector_auth_required`, `pluginKey=github`, and `connectorSlug=wework-github-cli`. Wework will offer a user-initiated GitHub login card and continue from the blocked operation after verification. Do not run an interactive login command inside an agent tool call.
- Network errors, missing repository permissions, and unsupported operations are not login success or reasons to switch to the official connector. Report the specific problem and keep the user's requested scope.
- Use `gh repo`, `gh pr`, `gh issue`, `gh run`, and `gh api` for supported operations. Repository listing can use `gh api user/repos --paginate --jq '.[] | {name: .full_name, url: .html_url}'`. Select the intended repository explicitly and require the usual user authorization for writes.
