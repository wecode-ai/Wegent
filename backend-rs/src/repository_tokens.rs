// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned GitLab placeholder credential resolution for the
//! repository routes.
//!
//! A deployment-specific provider patch replaces `GitLabProvider`'s methods so
//! an application whose deployment keeps `"***"` placeholders in
//! `users.git_info` resolves the real token through its own credential service
//! before each provider call. The public default keeps the stored value,
//! matching the unpatched source.
use async_trait::async_trait;

/// Resolves a stored GitLab placeholder token before a provider request.
///
/// The source wrapper (`_resolve_tokens_for_user`) runs before
/// `GitLabProvider.get_repositories` touches the cache, and calls
/// `TokenResolver.resolve_git_token(git_login, git_domain, fallback_token="***")`
/// for every `gitlab` entry whose stored token is `"***"`. A non-empty result
/// replaces the stored token for that entry; a falsy result leaves it in place
/// (`if token_result:`).
#[async_trait]
pub trait RepositoryTokenResolver: Send + Sync {
    /// The effective token for one entry. Returning the stored value keeps it
    /// unchanged.
    async fn resolve_gitlab_token(
        &self,
        git_login: &str,
        git_domain: &str,
        stored: &str,
    ) -> String {
        let _ = (git_login, git_domain);
        stored.to_string()
    }
}

/// No application Git credential service is registered.
pub struct StoredRepositoryTokens;

#[async_trait]
impl RepositoryTokenResolver for StoredRepositoryTokens {}
