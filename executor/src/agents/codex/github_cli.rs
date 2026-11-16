//! Host-owned GitHub CLI routing; installed marketplace packages stay immutable.

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
