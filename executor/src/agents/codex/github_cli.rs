//! Host-owned GitHub CLI routing; installed marketplace packages stay immutable.

pub(super) const INSTRUCTIONS: &str = r#"Wework GitHub CLI mode:
- GitHub tasks in this host use the local `gh` CLI, not `codex_apps.github` or ChatGPT GitHub connectors. This host rule overrides connector-first instructions in installed GitHub skills, including older versions.
- Check `gh api user --silent --hostname github.com` before GitHub operations. A request to run `gh auth login` or HTTP 401 means login is required; network errors and HTTP 403 are not proof of missing authentication. Do not read auth files, print tokens, call `gh auth token`, or request tokens in chat.
- If gh is missing, tell the user to install GitHub CLI on the execution device. Do not install software without permission.
- If authentication is missing or invalid, stop GitHub operations and return `connector_auth_required`, `pluginKey=github`, and `connectorSlug=wework-github-cli`. Wework will offer a user-initiated GitHub login card and retry the task after verification. Do not run an interactive login command inside an agent tool call.
- Network errors, missing repository permissions, and unsupported operations are not login success or reasons to switch to the official connector. Report the specific problem and keep the user's requested scope.
- Use `gh repo`, `gh pr`, `gh issue`, `gh run`, and `gh api` for supported operations. Repository listing can use `gh api user/repos --paginate --jq '.[] | {name: .full_name, url: .html_url}'`. Select the intended repository explicitly and require the usual user authorization for writes.
"#;

pub(super) fn is_reference(uri: &str) -> bool {
    if uri == "app://github" {
        return true;
    }
    let Some((name, marketplace)) = uri
        .strip_prefix("plugin://")
        .and_then(|id| id.split_once('@'))
    else {
        return false;
    };
    name.eq_ignore_ascii_case("github")
        && matches!(
            marketplace,
            "openai-bundled"
                | "openai-primary-runtime"
                | "openai-api-curated"
                | "openai-curated"
                | "openai-curated-remote"
                | "openai-official"
        )
}

pub(super) fn is_mention(name: &str, uri: &str) -> bool {
    is_reference(uri) || (uri.starts_with("app://") && name.eq_ignore_ascii_case("github"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_cli_only_routes_official_github_references() {
        assert!(is_reference("plugin://github@openai-curated-remote"));
        assert!(is_reference("plugin://github@openai-bundled"));
        assert!(is_reference("app://github"));
        assert!(!is_reference("plugin://github@company"));
        assert!(!is_reference(
            "plugin://github-enterprise@openai-curated-remote"
        ));
        assert!(!is_reference("app://gitlab"));
        assert!(is_mention("GitHub", "app://connector_account_specific_id"));
        assert!(!is_mention("GitLab", "app://connector_account_specific_id"));
    }
}
