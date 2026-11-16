//! Host-owned Git reads. Providers select operations, never commands or arbitrary URLs.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncRead;
use tokio::io::AsyncWriteExt;
use tokio::{io::AsyncReadExt, process::Command};

pub(crate) const PACKAGE: &str = "@wegent/dsh-connection-git/";

pub(super) fn uses_webhook(source: &Value) -> bool {
    source["kind"] == "repository" && source["transport"] != "cli"
}

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("git_connection_invalid", message)
}

pub(super) fn provider(input: &Value) -> Result<&str, AppIpcError> {
    input["providerId"]
        .as_str()
        .and_then(|id| id.strip_prefix(PACKAGE))
        .filter(|s| matches!(*s, "github" | "gitlab"))
        .ok_or_else(|| invalid("Unknown Git connection"))
}

pub(super) fn instance(input: &Value, platform: &str) -> Result<String, AppIpcError> {
    let address = input["instance"]
        .as_str()
        .unwrap_or(if platform == "github" {
            "https://github.com"
        } else {
            "https://gitlab.com"
        });
    let url = url::Url::parse(address).map_err(|_| invalid("Invalid instance URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host_str().is_none()
        || (platform == "github" && url.host_str() != Some("github.com"))
    {
        return Err(invalid("Unsupported Git instance"));
    }
    Ok(url.origin().ascii_serialization())
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn endpoint(platform: &str, input: &Value) -> Result<String, AppIpcError> {
    let page = input["page"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 10000)
        .unwrap_or(1);
    let repo = input["repository"].as_str().unwrap_or("");
    let query = input["query"].as_str().unwrap_or("");
    if query.len() > 256 {
        return Err(invalid("Search is too long"));
    }
    let op = input["operation"].as_str().unwrap_or("");
    if op == "identity" {
        return Ok("user".into());
    }
    if op == "server_version" && platform == "gitlab" {
        return Ok("version".into());
    }
    if op == "repositories" {
        return Ok(if platform == "github" {
            format!("user/repos?per_page=100&page={page}&sort=updated")
        } else {
            format!(
                "projects?membership=true&per_page=100&page={page}&search={}",
                segment(query)
            )
        });
    }
    if op == "activity" || op == "received_activity" {
        return Ok(if platform == "github" {
            let login = input["login"]
                .as_str()
                .ok_or_else(|| invalid("Missing bound account"))?;
            let feed = if op == "received_activity" {
                "received_events"
            } else {
                "events"
            };
            format!("users/{}/{feed}?per_page=100&page={page}", segment(login))
        } else if op == "activity" {
            format!("events?per_page=100&page={page}&sort=desc")
        } else {
            return Err(invalid("Unsupported activity feed"));
        });
    }
    if op == "notifications" {
        return Ok(if platform == "github" {
            format!(
                "notifications?all=true&per_page=100&page={page}&since={}",
                segment(input["after"].as_str().unwrap_or(""))
            )
        } else {
            format!("todos?per_page=100&page={page}")
        });
    }
    if op == "assigned" || op == "reviews" {
        let login = input["login"]
            .as_str()
            .ok_or_else(|| invalid("Missing bound account"))?;
        return Ok(if platform == "github" {
            let filter = if op == "reviews" {
                "is:pr review-requested"
            } else {
                "assignee"
            };
            format!(
                "search/issues?q={}&per_page=100&page={page}",
                segment(&format!(
                    "{filter}:{login} updated:>={}",
                    input["after"].as_str().unwrap_or("1970-01-01")
                ))
            )
        } else {
            let filter = if op == "reviews" {
                "reviewer_id"
            } else {
                "assignee_id"
            };
            let entity = if op == "reviews" {
                "merge_requests"
            } else {
                "issues"
            };
            format!(
                "{entity}?scope=all&{filter}={}&state=all&per_page=100&page={page}&updated_after={}",
                segment(input["accountId"].as_str().unwrap_or("")),segment(input["after"].as_str().unwrap_or("1970-01-01T00:00:00Z"))
            )
        });
    }
    if repo.is_empty()
        || repo.len() > 512
        || repo
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(invalid("Invalid repository"));
    }
    let base = if platform == "github" {
        format!(
            "repos/{}",
            repo.split('/').map(segment).collect::<Vec<_>>().join("/")
        )
    } else {
        format!("projects/{}", segment(repo))
    };
    if op == "repository_events" {
        let order = if platform == "gitlab" {
            "&sort=desc"
        } else {
            ""
        };
        return Ok(format!("{base}/events?per_page=100&page={page}{order}"));
    }
    if op == "repository" {
        return Ok(base);
    }
    if op == "api" {
        let path = input["path"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 2048
                    && !s.starts_with('/')
                    && !s.contains(['\\', '\0', '#'])
                    && !s
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                    && !s.contains('%')
            })
            .ok_or_else(|| invalid("Invalid repository-relative API path"))?;
        return Ok(format!("{base}/{path}"));
    }
    let number = input["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| invalid("Missing object number"))?;
    let kind = input["entityKind"].as_str().unwrap_or("issue");
    let entity = if kind == "change_request" {
        if platform == "github" {
            "pulls"
        } else {
            "merge_requests"
        }
    } else {
        "issues"
    };
    let suffix = match op {
        "object" => format!("{entity}/{number}"),
        "comments" => {
            if platform == "github" {
                format!("issues/{number}/comments?per_page=100&page={page}")
            } else {
                format!(
                    "{entity}/{number}/notes?per_page=100&page={page}&order_by=updated_at&sort=asc"
                )
            }
        }
        "checks" if kind == "change_request" => {
            if platform == "github" {
                let sha = input["sha"]
                    .as_str()
                    .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    .ok_or_else(|| invalid("Invalid head SHA"))?;
                format!("commits/{sha}/check-runs?per_page=100&page={page}")
            } else {
                format!("merge_requests/{number}/pipelines?per_page=100&page={page}")
            }
        }
        _ => return Err(invalid("Unsupported Git read operation")),
    };
    Ok(format!("{base}/{suffix}"))
}

struct ApiReply {
    data: Value,
    poll_interval: u64,
}

pub(crate) struct GitRequestError {
    pub(crate) error: AppIpcError,
    pub(crate) uncertain: bool,
}

impl GitRequestError {
    fn not_sent(error: AppIpcError) -> Self {
        Self {
            error,
            uncertain: false,
        }
    }
}

impl From<AppIpcError> for GitRequestError {
    fn from(error: AppIpcError) -> Self {
        Self {
            error,
            uncertain: true,
        }
    }
}

async fn api(
    platform: &str,
    instance: &str,
    method: &str,
    endpoint: &str,
    body: Option<&Value>,
) -> Result<ApiReply, AppIpcError> {
    api_request(platform, instance, method, endpoint, body)
        .await
        .map_err(|failure| failure.error)
}

async fn bounded_output<R: AsyncRead + Unpin>(
    reader: R,
    limit: usize,
) -> Result<Vec<u8>, AppIpcError> {
    let mut output = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut output)
        .await
        .map_err(|_| invalid("Git CLI output failed"))?;
    if output.len() > limit {
        return Err(invalid("Git CLI response too large"));
    }
    Ok(output)
}
fn rate_limits() -> &'static Mutex<HashMap<String, i64>> {
    static LIMITS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    LIMITS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn rate_limit_failure(instance: &str) -> AppIpcError {
    let delay = rate_limits()
        .lock()
        .ok()
        .and_then(|limits| limits.get(instance).copied())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() + 60_000)
        .saturating_sub(chrono::Utc::now().timestamp_millis())
        .clamp(1, 3_600_000) as u64;
    AppIpcError::new(
        "git_rate_limited",
        "Git API rate limit reached; waiting for the platform deadline",
    )
    .with_retry_after_ms(delay)
}

struct DecodedReply<'a> {
    status: u16,
    poll_interval: u64,
    retry_at: Option<i64>,
    body: &'a [u8],
}

fn decode_reply(raw: &[u8]) -> Result<DecodedReply<'_>, AppIpcError> {
    let mut remaining = raw;
    let mut status = 200;
    let mut poll = 60;
    let mut retry = None;
    while remaining.starts_with(b"HTTP/") {
        let (end, delimiter) = remaining
            .windows(4)
            .position(|v| v == b"\r\n\r\n")
            .map(|i| (i, 4))
            .or_else(|| {
                remaining
                    .windows(2)
                    .position(|v| v == b"\n\n")
                    .map(|i| (i, 2))
            })
            .ok_or_else(|| invalid("Invalid Git API response headers"))?;
        let headers = std::str::from_utf8(&remaining[..end])
            .map_err(|_| invalid("Invalid Git API response headers"))?;
        status = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| invalid("Invalid HTTP status"))?;
        let mut exhausted = false;
        let mut reset = None;
        for line in headers.lines().skip(1) {
            if let Some((key, value)) = line.split_once(':') {
                if key.eq_ignore_ascii_case("x-poll-interval") {
                    poll = value.trim().parse::<u64>().unwrap_or(60).max(60);
                }
                if key.eq_ignore_ascii_case("retry-after") {
                    retry = value
                        .trim()
                        .parse::<i64>()
                        .ok()
                        .map(|seconds| {
                            chrono::Utc::now().timestamp_millis() + seconds.clamp(1, 86400) * 1000
                        })
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(value.trim())
                                .ok()
                                .map(|time| time.timestamp_millis())
                        });
                }
                if key.eq_ignore_ascii_case("x-ratelimit-remaining") {
                    exhausted = value.trim() == "0";
                }
                if key.eq_ignore_ascii_case("x-ratelimit-reset") {
                    reset = value
                        .trim()
                        .parse::<i64>()
                        .ok()
                        .map(|seconds| seconds.saturating_mul(1000));
                }
            }
        }
        if exhausted && status == 403 && retry.is_none() {
            retry = reset;
        }
        remaining = &remaining[end + delimiter..];
    }
    Ok(DecodedReply {
        status,
        poll_interval: poll,
        retry_at: retry,
        body: remaining,
    })
}

async fn api_request(
    platform: &str,
    instance: &str,
    method: &str,
    endpoint: &str,
    body: Option<&Value>,
) -> Result<ApiReply, GitRequestError> {
    let hostname = instance
        .strip_prefix("https://")
        .ok_or_else(|| GitRequestError::not_sent(invalid("Invalid instance")))?;
    let serialized = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| GitRequestError::not_sent(invalid("Invalid Git request")))?;
    if serialized
        .as_ref()
        .is_some_and(|body| body.len() > 256 * 1024)
    {
        return Err(GitRequestError::not_sent(invalid(
            "Git request body is too large",
        )));
    }
    if rate_limits()
        .lock()
        .ok()
        .and_then(|limits| limits.get(instance).copied())
        .is_some_and(|at| at > chrono::Utc::now().timestamp_millis())
    {
        return Err(GitRequestError::not_sent(rate_limit_failure(instance)));
    }
    let mut command = Command::new(if platform == "github" { "gh" } else { "glab" });
    command.args([
        "api",
        "--include",
        "--hostname",
        hostname,
        "--method",
        method,
    ]);
    if body.is_some() {
        command.args(["--input", "-"]);
    }
    command
        .arg(endpoint)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GLAB_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env(
            "PATH",
            crate::process_environment::normalized_process_path(
                &std::env::var("PATH").unwrap_or_default(),
            ),
        )
        .stdin(if body.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| {
        GitRequestError::not_sent(AppIpcError::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                "git_cli_missing"
            } else {
                "git_cli_failed"
            },
            "Git platform CLI is unavailable on this device",
        ))
    })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    tokio::time::timeout(Duration::from_secs(45),async {
        if let Some(serialized)=serialized {
            let mut stdin=child.stdin.take().unwrap();
            stdin.write_all(&serialized).await.map_err(|_|invalid("Git submission failed; inspect remote state"))?;
        }
        let (out,err)=tokio::try_join!(bounded_output(&mut stdout,2*1024*1024),bounded_output(&mut stderr,8192))?;
        let status=child.wait().await.map_err(|_|invalid("Git CLI failed"))?;
        let DecodedReply { status: http_status, poll_interval, retry_at: retry, body: response_body } = decode_reply(&out)?;
        if http_status==429 || (http_status==403 && retry.is_some()) {
            if let Ok(mut limits)=rate_limits().lock(){limits.insert(instance.to_owned(),retry.unwrap_or_else(||chrono::Utc::now().timestamp_millis()+60000));}
            return Err(GitRequestError::not_sent(rate_limit_failure(instance)));
        }
        if !status.success(){
            let text=String::from_utf8_lossy(&err).to_lowercase();
            let auth=http_status==401||status.code()==Some(4)||text.contains("auth login");
            let error = AppIpcError::new(if auth{"connector_auth_required"}else if http_status==403{"git_permission_denied"}else if http_status==404{"git_not_found"}else{"git_cli_failed"},"Git operation failed; check account permissions and connectivity. Inspect remote state before repeating a write.");
            return Err(GitRequestError {error, uncertain: !definite_rejection(http_status)});
        }
        let data=if response_body.is_empty(){json!({"success":true})}else{serde_json::from_slice(response_body).map_err(|_|invalid("Invalid Git CLI JSON response; inspect remote state before repeating a write"))?};
        Ok(ApiReply{data,poll_interval})
    }).await.map_err(|_|GitRequestError::from(AppIpcError::new("git_cli_timeout","Git request timed out; inspect remote state before repeating a write")))?
}

fn definite_rejection(status: u16) -> bool {
    matches!(
        status,
        400 | 401 | 403 | 404 | 405 | 409 | 410 | 415 | 422 | 429
    )
}

pub(crate) async fn read(input: Value) -> Result<Value, AppIpcError> {
    let platform = provider(&input)?;
    let instance = instance(&input, platform)?;
    let identity = api(platform, &instance, "GET", "user", None).await?.data;
    let id = identity["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| identity["id"].to_string());
    let login = identity["login"]
        .as_str()
        .or(identity["username"].as_str())
        .ok_or_else(|| invalid("Missing account identity"))?;
    if id == "null" {
        return Err(invalid("Missing account ID"));
    }
    let profile = json!([instance, id]).to_string();
    if let Some(expected) = input["profile"].as_str() {
        if expected != profile {
            return Err(AppIpcError::new(
                "git_account_changed",
                "The selected CLI account changed",
            ));
        }
    }
    if input["operation"] == "identity" {
        return Ok(json!({"profile":profile,"accountId":id,"login":login,"instance":instance}));
    }
    if input["operation"] == "job_log" {
        endpoint(
            platform,
            &json!({"operation":"repository","repository":input["repository"]}),
        )?;
        let job = input["jobId"]
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid("A job ID is required"))?
            .to_string();
        let repository = format!(
            "{}/{}",
            instance,
            input["repository"].as_str().unwrap_or("")
        );
        let mut command = Command::new(if platform == "github" { "gh" } else { "glab" });
        if platform == "github" {
            command.args([
                "run",
                "view",
                "--repo",
                &repository,
                "--job",
                &job,
                "--log-failed",
            ]);
        } else {
            command.args(["ci", "trace", &job, "--repo", &repository]);
        }
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GLAB_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .env(
                "PATH",
                crate::process_environment::normalized_process_path(
                    &std::env::var("PATH").unwrap_or_default(),
                ),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| invalid("CI log reader could not start"))?;
        let output = tokio::time::timeout(Duration::from_secs(45), async {
            let output = bounded_output(child.stdout.take().unwrap(), 2 * 1024 * 1024).await?;
            let status = child
                .wait()
                .await
                .map_err(|_| invalid("CI log reader failed"))?;
            if !status.success() {
                return Err(invalid(
                    "CI job log is unavailable; check repository permission and job identity",
                ));
            }
            Ok(output)
        })
        .await
        .map_err(|_| invalid("CI log read timed out"))??;
        return Ok(
            json!({"data":{"text":String::from_utf8_lossy(&output),"jobId":job},"profile":profile}),
        );
    }
    let mut bound = input.clone();
    bound["accountId"] = json!(id);
    bound["login"] = json!(login);
    let path = endpoint(platform, &bound)?;
    let data = api(platform, &instance, "GET", &path, None).await?;
    Ok(json!({"data":data.data,"profile":profile,"pollIntervalSeconds":data.poll_interval}))
}

pub(crate) fn write_target(input: &Value) -> Result<(&str, String), AppIpcError> {
    let platform = provider(input)?;
    instance(input, platform)?;
    if !input["body"].is_object() {
        return Err(invalid("A JSON object body is required"));
    }
    let method = input["method"]
        .as_str()
        .filter(|s| matches!(*s, "POST" | "PUT" | "PATCH" | "DELETE"))
        .ok_or_else(|| invalid("Invalid Git write method"))?;
    let mut path_input = input.clone();
    path_input["operation"] = json!("api");
    let path = endpoint(platform, &path_input)?;
    if path
        .split('?')
        .next()
        .is_some_and(|p| p.ends_with("/merge"))
        && !input["body"]["sha"]
            .as_str()
            .is_some_and(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid("Merging requires the exact reviewed head SHA"));
    }
    Ok((method, path))
}

pub(crate) async fn write(input: Value) -> Result<Value, GitRequestError> {
    let platform = provider(&input).map_err(GitRequestError::not_sent)?;
    let instance = instance(&input, platform).map_err(GitRequestError::not_sent)?;
    // Verify the exact bound account immediately before the approved operation.
    let mut check = input.clone();
    check["operation"] = json!("identity");
    read(check).await.map_err(GitRequestError::not_sent)?;
    let (method, path) = write_target(&input).map_err(GitRequestError::not_sent)?;
    let mut result = api_request(platform, &instance, method, &path, Some(&input["body"]))
        .await?
        .data;
    let parts: Vec<_> = input["path"].as_str().unwrap_or("").split('/').collect();
    if parts
        .iter()
        .any(|part| matches!(*part, "comments" | "notes"))
    {
        let mut comment = result.clone();
        if method == "DELETE" {
            if let Some(id) = parts.last().and_then(|id| id.parse::<u64>().ok()) {
                comment["id"] = json!(id);
            }
        }
        if let Some(id) = comment_event_id(
            platform,
            &instance,
            input["repository"].as_str().unwrap_or(""),
            &comment,
            method == "DELETE",
        ) {
            result["canonicalEventId"] = json!(id);
        }
    }
    Ok(result)
}

fn comment_event_id(
    platform: &str,
    instance: &str,
    repository: &str,
    comment: &Value,
    deleted: bool,
) -> Option<String> {
    use sha2::{Digest, Sha256};
    let id = comment.get("id")?;
    let id = id
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string());
    let identity = if deleted {
        json!([platform, instance, repository, "comment", id, "deleted"])
    } else {
        let raw = comment["updated_at"]
            .as_str()
            .or(comment["created_at"].as_str())?;
        let normalized = raw.replace(" UTC", "Z").replacen(' ', "T", 1);
        let version = chrono::DateTime::parse_from_rfc3339(&normalized)
            .ok()?
            .timestamp_millis()
            .to_string();
        let body = comment["body"].as_str().or(comment["note"].as_str())?;
        json!([platform, instance, repository, "comment", id, version, body, "upsert"])
    };
    Some(format!(
        "git-canonical:{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preflight_failures_are_definitely_unsent() {
        let oversized = json!({"body":"x".repeat(256*1024)});
        let failure = api_request(
            "github",
            "https://github.com",
            "POST",
            "repos/org/repo/issues",
            Some(&oversized),
        )
        .await
        .err()
        .unwrap();
        assert!(!failure.uncertain);
        let host = "https://git-preflight-limit.invalid";
        rate_limits()
            .lock()
            .unwrap()
            .insert(host.into(), chrono::Utc::now().timestamp_millis() + 60000);
        let result =
            api_request("gitlab", host, "POST", "projects/1/hooks", Some(&json!({}))).await;
        rate_limits().lock().unwrap().remove(host);
        let failure = result.err().unwrap();
        assert_eq!(failure.error.code, "git_rate_limited");
        assert!(failure
            .error
            .retry_after_ms
            .is_some_and(|delay| (1..=60_000).contains(&delay)));
        assert!(!failure.uncertain);
    }
    #[test]
    fn merge_paths_cannot_bypass_head_validation_with_empty_segments() {
        for path in ["pulls/9/merge/", "pulls//9/merge", "pulls/9/merge/?a=b"] {
            assert!(write_target(&json!({"providerId":format!("{PACKAGE}github"),"repository":"org/repo","path":path,"method":"PUT","body":{}})).is_err());
        }
        assert!(write_target(&json!({"providerId":format!("{PACKAGE}github"),"repository":"org/repo","path":"pulls/9/merge?mode=squash","method":"PUT","body":{}})).is_err());
        assert!(write_target(&json!({"providerId":format!("{PACKAGE}github"),"repository":"org/repo","path":"pulls/9/merge?mode=squash","method":"PUT","body":{"sha":"a".repeat(40)}})).is_ok());
    }

    #[test]
    fn rejection_certainty_never_infers_success_from_network_or_server_errors() {
        for status in [400, 401, 403, 404, 422, 429] {
            assert!(definite_rejection(status));
        }
        for status in [0, 200, 302, 408, 500, 502, 503, 504] {
            assert!(!definite_rejection(status));
        }
        assert!(GitRequestError::from(invalid("output truncated")).uncertain);
        assert!(!GitRequestError::not_sent(invalid("preflight failed")).uncertain);
    }

    #[test]
    fn canonical_comment_versions_match_equivalent_timestamp_formats() {
        let id = |version: &str| {
            comment_event_id(
                "gitlab",
                "https://gitlab.example",
                "org/repo",
                &json!({"id":11,"updated_at":version,"note":"same reply"}),
                false,
            )
        };
        assert_eq!(
            id("2026-02-01T00:00:00Z").as_deref(),
            Some("git-canonical:30bddc52cd52d15c6015b7dae9db9c383e6795bfd2c02a85d4512bf4798d08a2")
        );
        assert_eq!(
            id("2026-02-01 00:00:00 UTC"),
            id("2026-02-01T00:00:00.000Z")
        );
        assert_eq!(id("2026-02-01T01:00:00+01:00"), id("2026-02-01T00:00:00Z"));
        assert_ne!(id("2026-02-01T00:00:00.001Z"), id("2026-02-01T00:00:00Z"));
        assert_eq!(id("invalid"), None);
    }
    #[test]
    fn http_metadata_distinguishes_rate_limits_from_permission_denials() {
        let DecodedReply {
            status,
            poll_interval: poll,
            retry_at: retry,
            body,
        } = decode_reply(b"HTTP/2.0 200 OK\r\nX-Poll-Interval: 120\r\n\r\n[]").unwrap();
        assert_eq!(status, 200);
        assert_eq!(poll, 120);
        assert!(retry.is_none());
        assert_eq!(body, b"[]");
        let retry=decode_reply(b"HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 17\r\nX-RateLimit-Reset: 9999999999\r\n\r\n{}").unwrap().retry_at;
        assert!(
            retry.is_none(),
            "ordinary permission failures must not become rate-limit pauses"
        );
        let retry = decode_reply(b"HTTP/2.0 429 Too Many Requests\r\nRetry-After: 300\r\n\r\n{}")
            .unwrap()
            .retry_at;
        assert!(retry.unwrap() > chrono::Utc::now().timestamp_millis() + 299000);
    }
    #[test]
    fn cli_event_feeds_are_bound_to_the_selected_account_and_repository() {
        assert_eq!(
            endpoint(
                "github",
                &json!({"operation":"activity","login":"alice","page":2})
            )
            .unwrap(),
            "users/alice/events?per_page=100&page=2"
        );
        assert_eq!(
            endpoint(
                "github",
                &json!({"operation":"received_activity","login":"alice"})
            )
            .unwrap(),
            "users/alice/received_events?per_page=100&page=1"
        );
        assert_eq!(
            endpoint(
                "github",
                &json!({"operation":"repository_events","repository":"org/repo"})
            )
            .unwrap(),
            "repos/org/repo/events?per_page=100&page=1"
        );
        assert_eq!(
            endpoint(
                "gitlab",
                &json!({"operation":"repository_events","repository":"group/sub/repo"})
            )
            .unwrap(),
            "projects/group%2Fsub%2Frepo/events?per_page=100&page=1&sort=desc"
        );
        assert_eq!(
            endpoint("gitlab", &json!({"operation":"activity"})).unwrap(),
            "events?per_page=100&page=1&sort=desc"
        );
        assert!(endpoint("github", &json!({"operation":"activity"})).is_err());
        assert!(endpoint(
            "github",
            &json!({"operation":"repository_events","repository":"org/../other"})
        )
        .is_err());
        assert!(!uses_webhook(
            &json!({"kind":"repository","transport":"cli"})
        ));
        assert!(uses_webhook(
            &json!({"kind":"repository","subscriptionId":"existing"})
        ));
    }

    #[test]
    fn reads_cannot_select_arbitrary_commands_hosts_or_api_methods() {
        assert_eq!(
            endpoint("gitlab", &json!({"operation":"server_version"})).unwrap(),
            "version"
        );
        assert!(endpoint("github", &json!({"operation":"server_version"})).is_err());
        assert!(endpoint(
            "github",
            &json!({"operation":"delete","repository":"org/repo","number":1})
        )
        .is_err());
        assert!(endpoint(
            "github",
            &json!({"operation":"repository","repository":"org/../secret"})
        )
        .is_err());
        assert!(instance(&json!({"instance":"https://token@github.com"}), "github").is_err());
        assert!(instance(&json!({"instance":"https://github.example"}), "github").is_err());
        assert_eq!(
            endpoint(
                "gitlab",
                &json!({"operation":"repository","repository":"group/sub/repo"})
            )
            .unwrap(),
            "projects/group%2Fsub%2Frepo"
        );
        assert!(provider(&json!({"providerId":"@untrusted/plugin/github"})).is_err());
    }
}
