//! Repository access is authoritative; revision/diff discovery is best effort.
use crate::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::Json;
use serde_json::Value;

pub(super) struct Repository {
    pub source: Value,
    pub token: String,
    pub base: String,
    pub project: String,
    pub http: brz_http::Client,
}
#[derive(Default)]
pub(super) struct Revision {
    pub head: String,
    pub changed: Option<Vec<String>>,
    pub count: Option<u64>,
}
pub(super) async fn resolve(app: &AppState, user: i64, source: &Value) -> Result<Repository> {
    let provider = source["sourceType"].as_str().unwrap_or("");
    if !matches!(provider, "github" | "gitlab" | "gitea") {
        bail!("REPOSITORY_ACCESS_DENIED: unsupported repository type")
    }
    let domain = source["sourceDomain"]
        .as_str()
        .context("Code Wiki source domain missing")?;
    let project = source["projectName"]
        .as_str()
        .filter(|v| !v.is_empty())
        .context("Code Wiki source repository missing")?;
    if source["sourceUrl"].as_str().is_none_or(|s| s.is_empty()) {
        bail!("Code Wiki source URL missing")
    }
    let row: Option<brz_mysql::MysqlRow> = app
        .mysql
        .fetch_optional("SELECT git_info FROM users WHERE id=?", (user,))
        .await?;
    let info = row
        .and_then(|r| r.get_at::<Option<Json<Value>>>(0).ok().flatten())
        .map(|v| v.0)
        .unwrap_or(Value::Null);
    let accounts = if info.is_array() {
        info.as_array().cloned().unwrap_or_default()
    } else {
        vec![info]
    };
    let mut token = String::new();
    for account in accounts {
        let stored = account["git_domain"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        if stored
            != domain
                .trim_end_matches('/')
                .trim_start_matches("https://")
                .trim_start_matches("http://")
        {
            continue;
        }
        if account["type"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v != provider)
        {
            bail!(
                "REPOSITORY_ACCESS_DENIED: configured credential provider does not match repository"
            )
        }
        token = crate::git_repositories::crypto::decrypt_git_token(
            account["git_token"].as_str().unwrap_or(""),
        )
        .map_err(|_| anyhow::anyhow!("Git credential decryption failed"))?;
        if provider == "gitlab" && token == "***" {
            token = app
                .repository_tokens
                .resolve_gitlab_token(
                    account["git_login"]
                        .as_str()
                        .or(account["user_name"].as_str())
                        .unwrap_or(""),
                    domain,
                    &token,
                )
                .await;
        }
        if token == "***" {
            token.clear()
        }
        break;
    }
    let origin = if domain.starts_with("http://") || domain.starts_with("https://") {
        domain.trim_end_matches('/').to_owned()
    } else {
        format!("https://{domain}")
    };
    let base = match provider {
        "github" if domain == "github.com" => "https://api.github.com".into(),
        "github" => format!("{origin}/api/v3"),
        "gitlab" => format!("{origin}/api/v4"),
        _ => format!("{origin}/api/v1"),
    };
    let http = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(super::model::setting(
            "REPOSITORY_READ_TIMEOUT_SECONDS",
            30,
        )))
        .build()?;
    let repo = Repository {
        source: source.clone(),
        token,
        base,
        project: project.into(),
        http,
    };
    if !repo.token.is_empty() && repo.authenticated_access().await.unwrap_or(false) {
        return Ok(repo);
    }
    let public = repo
        .get(&repo.metadata_path(), false)
        .await
        .context("REPOSITORY_ACCESS_DENIED: repository is not publicly readable")?;
    let visible = if provider == "gitlab" {
        public["visibility"] == "public"
    } else {
        public["private"] == false
    };
    if !visible {
        bail!("REPOSITORY_ACCESS_DENIED: repository is not publicly readable")
    }
    Ok(repo)
}
impl Repository {
    async fn authenticated_access(&self) -> Result<bool> {
        let user = self.get("/user", true).await?;
        match self.provider() {
            "gitlab" => {
                let id = user["id"].as_i64().context("GitLab user ID missing")?;
                // Preserve the source provider's membership contract, including
                // inherited membership returned by members/all.
                let member = self
                    .get(&format!("{}/members/all/{id}", self.metadata_path()), true)
                    .await?;
                Ok(member["access_level"]
                    .as_i64()
                    .is_some_and(|level| level > 0))
            }
            "github" => {
                let login = user["login"]
                    .as_str()
                    .context("GitHub user login missing")?;
                let path = format!(
                    "{}/collaborators/{}/permission",
                    self.metadata_path(),
                    encode(login)
                );
                let mut request = self
                    .http
                    .get(format!("{}{path}", self.base))?
                    .header("authorization", format!("token {}", self.token))
                    .header("accept", "application/vnd.github.v3+json");
                request = request.header("user-agent", "Wegent");
                let response = request.send().await?;
                if response.status().as_u16() == 403 {
                    // The source permits a token that can read the repository
                    // but cannot inspect collaborator permissions.
                    return Ok(self.get(&self.metadata_path(), true).await.is_ok());
                }
                if !response.status().is_success() {
                    return Ok(false);
                }
                let permission: Value = response.json().await?;
                Ok(matches!(
                    permission["permission"].as_str(),
                    Some("admin" | "maintain" | "push" | "triage" | "pull")
                ))
            }
            _ => {
                let metadata = self.get(&self.metadata_path(), true).await?;
                Ok(["admin", "push", "write", "pull", "read"]
                    .into_iter()
                    .any(|name| metadata["permissions"][name] == true))
            }
        }
    }
    fn provider(&self) -> &str {
        self.source["sourceType"].as_str().unwrap_or("")
    }
    fn metadata_path(&self) -> String {
        if self.provider() == "gitlab" {
            format!("/projects/{}", encode(&self.project))
        } else {
            format!("/repos/{}", self.project)
        }
    }
    async fn request(&self, path: &str, authenticated: bool) -> Result<brz_http::Response> {
        let mut request = self
            .http
            .get(format!("{}{path}", self.base))?
            .header("accept", "application/json")
            .header("user-agent", "Wegent");
        if authenticated && !self.token.is_empty() {
            request = if self.provider() == "gitlab" {
                request.header("PRIVATE-TOKEN", &self.token)
            } else {
                request.header("authorization", format!("token {}", self.token))
            }
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            bail!(
                "Repository request returned HTTP {}",
                response.status().as_u16()
            )
        }
        Ok(response)
    }
    async fn get(&self, path: &str, authenticated: bool) -> Result<Value> {
        Ok(self.request(path, authenticated).await?.json().await?)
    }
    pub(super) async fn revision(&self, previous: &str, need_count: bool) -> Revision {
        if self.token.is_empty() {
            return Revision::default();
        }
        let result: Result<Revision> = async {
            let repo = self.get(&self.metadata_path(), true).await?;
            let branch = repo["default_branch"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("main");
            let suffix = if self.provider() == "gitlab" {
                format!("/repository/branches/{}", encode(branch))
            } else {
                format!("/branches/{}", encode(branch))
            };
            let branch = self
                .get(&format!("{}{suffix}", self.metadata_path()), true)
                .await?;
            let head = branch["commit"][if self.provider() == "github" {
                "sha"
            } else {
                "id"
            }]
            .as_str()
            .unwrap_or("")
            .to_owned();
            let mut revision = Revision {
                head,
                ..Revision::default()
            };
            if previous.is_empty() || revision.head.is_empty() {
                return Ok(revision);
            }
            if previous == revision.head {
                revision.changed = Some(Vec::new());
                return Ok(revision);
            }
            revision.changed = self.diff(previous, &revision.head).await.ok().flatten();
            if need_count && revision.changed.as_ref().is_some_and(|v| !v.is_empty()) {
                revision.count = self.count(&revision.head).await.ok().flatten()
            }
            Ok(revision)
        }
        .await;
        match result {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error,"Code Wiki repository revision is unknown");
                Revision::default()
            }
        }
    }
    async fn diff(&self, previous: &str, head: &str) -> Result<Option<Vec<String>>> {
        let path = if self.provider() == "gitlab" {
            format!(
                "{}/repository/compare?from={}&to={}",
                self.metadata_path(),
                encode(previous),
                encode(head)
            )
        } else {
            format!(
                "{}/compare/{}...{}",
                self.metadata_path(),
                encode(previous),
                encode(head)
            )
        };
        let value = self.get(&path, true).await?;
        if self.provider() == "gitlab" && value["compare_timeout"] == true {
            return Ok(None);
        }
        let files = value[if self.provider() == "gitlab" {
            "diffs"
        } else {
            "files"
        }]
        .as_array()
        .cloned()
        .unwrap_or_default();
        if self.provider() == "github" && files.len() >= 300 {
            return Ok(None);
        }
        Ok(Some(
            files
                .iter()
                .filter_map(|file| {
                    if self.provider() == "gitlab" {
                        file["new_path"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .or(file["old_path"].as_str())
                    } else {
                        file["filename"].as_str()
                    }
                })
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        ))
    }
    async fn count(&self, head: &str) -> Result<Option<u64>> {
        let mut total = 0;
        let mut next = "1".to_owned();
        let mut seen = std::collections::BTreeSet::new();
        for page in 1..=1000 {
            let path = if self.provider() == "gitlab" {
                format!(
                    "{}/repository/tree?ref={}&recursive=true&per_page=100&page={}",
                    self.metadata_path(),
                    encode(head),
                    next
                )
            } else {
                format!(
                    "{}/git/trees/{}?recursive={}&per_page=100&page={page}",
                    self.metadata_path(),
                    encode(head),
                    if self.provider() == "github" {
                        "1"
                    } else {
                        "true"
                    }
                )
            };
            let response = self.request(&path, true).await?;
            let next_header = response
                .headers()
                .get("x-next-page")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let data: Value = response.json().await?;
            let tree = if self.provider() == "gitlab" {
                data.as_array()
            } else {
                data["tree"].as_array()
            };
            let Some(tree) = tree else { return Ok(None) };
            total += tree.iter().filter(|v| v["type"] == "blob").count() as u64;
            match self.provider() {
                "github" => return Ok((data["truncated"] != true && total > 0).then_some(total)),
                "gitlab" => {
                    if next_header.is_empty() {
                        return Ok((total > 0).then_some(total));
                    }
                    if !seen.insert(next.clone()) {
                        return Ok(None);
                    }
                    next = next_header
                }
                _ if data["truncated"] != true => return Ok((total > 0).then_some(total)),
                _ => {}
            }
        }
        Ok(None)
    }
}
fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
