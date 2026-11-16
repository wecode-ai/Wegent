//! Full repository-cache refresh, bypassing the request path's cached page.

use brz_http::Client;
use brz_json::OpaqueJson;
use serde::Serialize;
use serde_json::Value;

use super::cache::RepositoryCache;
use super::providers::{self, Provider, RefreshRequest};
use crate::repository_tokens::RepositoryTokenResolver;

#[derive(Default, Debug, Serialize, PartialEq, Eq)]
pub struct RepositoryRefreshReport {
    pub refreshed: usize,
    pub skipped: usize,
    pub failed: usize,
}

pub(super) async fn refresh_user(
    client: &Client,
    cache: &dyn RepositoryCache,
    resolver: &dyn RepositoryTokenResolver,
    user_id: i32,
    user_name: &str,
    git_info: &OpaqueJson,
) -> RepositoryRefreshReport {
    let mut report = RepositoryRefreshReport::default();
    let Some(Value::Array(items)) = git_info.project::<Value>() else {
        return report;
    };
    // The periodic source supports these four providers and preserves entry order.
    for item in items {
        let Some(provider) = supported_provider(&item) else {
            report.skipped += 1;
            continue;
        };
        let single = OpaqueJson::from(Value::Array(vec![item]));
        let mut entries = match providers::entries(provider, &single) {
            Ok(entries) => entries,
            Err(_) => {
                report.failed += 1;
                continue;
            }
        };
        if provider == Provider::Gitlab {
            super::service::resolve_gitlab_tokens(resolver, &mut entries).await;
        }
        for entry in entries {
            let request = RefreshRequest {
                provider,
                user_id,
                user_name: user_name.to_owned(),
                git_domain: entry.git_domain,
                git_token: entry.git_token,
                gerrit_user: entry.user_name,
                auth_type: entry.auth_type,
            };
            providers::refresh(client, cache, &request).await;
            report.refreshed += 1;
        }
    }
    report
}

fn supported_provider(item: &Value) -> Option<Provider> {
    if item.get("git_domain").and_then(Value::as_str)?.is_empty()
        || item.get("git_token").and_then(Value::as_str)?.is_empty()
    {
        return None;
    }
    match item.get("type").and_then(Value::as_str)? {
        "github" => Some(Provider::Github),
        "gitlab" => Some(Provider::Gitlab),
        "gitee" => Some(Provider::Gitee),
        "gitea" => Some(Provider::Gitea),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn periodic_refresh_requires_domain_and_token_and_excludes_gerrit() {
        for item in [
            json!({"type":"github", "git_domain":"", "git_token":"token"}),
            json!({"type":"gitlab", "git_domain":"git.example", "git_token":""}),
            json!({"type":"gerrit", "git_domain":"git.example", "git_token":"token"}),
        ] {
            assert!(supported_provider(&item).is_none());
        }
        assert_eq!(
            supported_provider(&json!({
                "type":"github", "git_domain":"github.com", "git_token":"token"
            })),
            Some(Provider::Github)
        );
    }

    struct Cache {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
    }

    #[async_trait]
    impl RepositoryCache for Cache {
        async fn get(&self, _: &str) -> Option<Vec<u8>> {
            None
        }
        async fn set(&self, key: &str, value: Vec<u8>) {
            self.writes.lock().unwrap().push((key.to_owned(), value));
        }
        async fn is_building(&self, _: i32, _: &str) -> bool {
            false
        }
        async fn set_building(&self, _: i32, _: &str, _: bool) {}
    }

    #[tokio::test]
    async fn full_refresh_calls_the_provider_and_replaces_the_domain_cache() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("GET /api/v3/user/repos?"));
            assert!(request.contains("page=1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: token stored-token")
            );
            let body = r#"[{"id":17,"name":"repo","full_name":"owner/repo","clone_url":"https://git.example/owner/repo.git","private":true}]"#;
            socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let cache = Cache {
            writes: Mutex::new(Vec::new()),
        };
        let domain = format!("http://{address}");
        let report = refresh_user(
            &providers::build_client().unwrap(),
            &cache,
            &crate::repository_tokens::StoredRepositoryTokens,
            7,
            "alice",
            &OpaqueJson::from(json!([{
                "type":"github", "git_domain":domain, "git_token":"stored-token"
            }])),
        )
        .await;
        server.await.unwrap();
        assert_eq!(
            report,
            RepositoryRefreshReport {
                refreshed: 1,
                skipped: 0,
                failed: 0
            }
        );
        let writes = cache.writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, format!("git_repos:7:{domain}"));
        let repos: Value = serde_json::from_slice(&writes[0].1).unwrap();
        assert_eq!(repos[0]["full_name"], "owner/repo");
        assert_eq!(repos[0]["private"], true);
    }
}
