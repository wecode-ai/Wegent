//! Execute plugin-declared tool binaries with isolated JSON output handling.
use super::*;
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_TOOL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn connection_auth_target(
    root: &Path,
    plugin_key: &str,
    declaration: &Value,
) -> Result<Value, AppIpcError> {
    let manifest = read_plugin_manifest(root)?;
    if manifest["name"].as_str() != Some(plugin_key) {
        return Err(AppIpcError::new(
            "connection_dependency_denied",
            "Installed plugin manifest identity does not match",
        ));
    }
    let matches: Vec<&Value> = manifest["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|connector| {
            connector["localAuth"].is_object()
                && if let Some(tool) = declaration["toolId"].as_str() {
                    connector["localAuth"]["tool"]["id"].as_str() == Some(tool)
                } else {
                    connector["slug"] == declaration["connectorSlug"]
                }
        })
        .collect();
    if matches.len() != 1 {
        return Err(AppIpcError::new(
            "connection_tool_unavailable",
            "The dependency must declare one matching localAuth tool",
        ));
    }
    let slug = matches[0]["slug"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppIpcError::new("local_auth_invalid", "Missing connector identity"))?;
    parse_local_auth_spec(&manifest, Some(slug))?;
    Ok(json!({"pluginKey":plugin_key,"connectorSlug":slug}))
}

// Replies retain the existing source-bound permission checks in the caller.
pub(crate) async fn run_plugin_tool(
    plugin_key: &str,
    connector_slug: &str,
    args: &[String],
) -> Result<Value, AppIpcError> {
    let (root, _) =
        resolve_request(&json!({"pluginKey":plugin_key,"connectorSlug":connector_slug}))?;
    run_connection_tool(&root, plugin_key, connector_slug, args).await
}

pub(crate) async fn run_connection_tool(
    root: &Path,
    plugin_key: &str,
    connector_slug: &str,
    args: &[String],
) -> Result<Value, AppIpcError> {
    let manifest = read_plugin_manifest(root)?;
    if manifest["name"].as_str() != Some(plugin_key) {
        return Err(AppIpcError::new(
            "connection_dependency_denied",
            "Installed plugin manifest identity does not match",
        ));
    }
    let spec = parse_local_auth_spec(&manifest, Some(connector_slug))?;
    let tool = resolve_auth_tool(spec.tool.as_ref(), false)
        .await?
        .ok_or_else(|| {
            AppIpcError::new(
                "local_auth_tool_missing",
                "The dependency must declare a localAuth tool",
            )
        })?;
    run_tool_json(root, &tool, args, plugin_key, connector_slug).await
}

async fn run_tool_json(
    root: &Path,
    tool: &Path,
    args: &[String],
    plugin_key: &str,
    connector_slug: &str,
) -> Result<Value, AppIpcError> {
    let mut command = Command::new(tool);
    crate::process::hide_windows_console(&mut command);
    let mut child = command
        .args(args)
        .current_dir(root)
        .envs(crate::plugin_account_auth::broker::environment())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            AppIpcError::new(
                "connection_cli_unavailable",
                "Plugin tool could not be started",
            )
        })?;
    let stdout = child.stdout.take().expect("piped plugin stdout");
    let output = tokio::time::timeout(Duration::from_secs(40), async {
        let stdout = read_tool_stdout(stdout, MAX_TOOL_OUTPUT_BYTES).await?;
        let status = child
            .wait()
            .await
            .map_err(|_| AppIpcError::new("connection_cli_failed", "Plugin tool wait failed"))?;
        Ok::<_, AppIpcError>((stdout, status))
    })
    .await
    .map_err(|_| AppIpcError::new("connection_cli_timeout", "Plugin tool request timed out"))??;
    let result =
        parse_connection_tool_output(&output.0, output.1.success(), plugin_key, connector_slug);
    if result
        .as_ref()
        .is_err_and(|error| error.code == "connection_cli_response_invalid")
    {
        crate::logging::log_executor_event(
            "Connection tool output rejected",
            &[
                ("plugin_key", plugin_key.to_owned()),
                ("connector_slug", connector_slug.to_owned()),
                (
                    "tool",
                    tool.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                ),
                (
                    "diagnostic",
                    output_diagnostic(&output.0, output.1.success(), output.1.code()).to_string(),
                ),
            ],
        );
    }
    result
}

// Only structural metadata may leave the CLI boundary; never include output or arguments.
fn output_diagnostic(bytes: &[u8], success: bool, exit_code: Option<i32>) -> Value {
    let first = bytes.iter().find(|byte| !byte.is_ascii_whitespace());
    let first_kind = match first {
        None => "empty",
        Some(b'{') => "object",
        Some(b'[') => "array",
        Some(_) => "other",
    };
    let error = serde_json::from_slice::<Value>(bytes).err();
    json!({
        "stdoutBytes":bytes.len(),
        "exitSuccess":success,
        "exitCode":exit_code,
        "utf8":std::str::from_utf8(bytes).is_ok(),
        "bom":bytes.starts_with(&[0xef,0xbb,0xbf]),
        "firstKind":first_kind,
        "jsonError":error.as_ref().map(|error|format!("{:?}",error.classify())),
        "line":error.as_ref().map(serde_json::Error::line),
        "column":error.as_ref().map(serde_json::Error::column),
    })
}

async fn read_tool_stdout(
    stdout: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, AppIpcError> {
    let mut bytes = Vec::new();
    stdout
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| {
            AppIpcError::new(
                "connection_cli_failed",
                "Plugin tool output could not be read",
            )
        })?;
    if bytes.len() > limit {
        return Err(AppIpcError::new(
            "connection_cli_response_invalid",
            "Plugin tool response exceeded the size limit",
        ));
    }
    Ok(bytes)
}

fn parse_connection_tool_output(
    bytes: &[u8],
    success: bool,
    plugin_key: &str,
    connector_slug: &str,
) -> Result<Value, AppIpcError> {
    if bytes.len() > MAX_TOOL_OUTPUT_BYTES {
        return Err(AppIpcError::new(
            "connection_cli_response_invalid",
            "Plugin tool response exceeded the size limit",
        ));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        AppIpcError::new(
            "connection_cli_response_invalid",
            "Plugin tool did not return JSON",
        )
    })?;
    if !success || value["success"] == false || value["ok"] == false {
        let code = value["error"]["code"]
            .as_str()
            .or_else(|| value["errorCode"].as_str())
            .or_else(|| value["code"].as_str())
            .unwrap_or("request_failed");
        if matches!(
            code,
            "need_login" | "AUTH_REQUIRED" | "connector_auth_required" | "NOT_LOGGED_IN"
        ) {
            return Err(AppIpcError::new(
                "connector_auth_required",
                format!("pluginKey={plugin_key} connectorSlug={connector_slug}"),
            ));
        }
        return Err(AppIpcError::new(
            "connection_cli_failed",
            "Plugin tool request failed",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod connection_tool_tests {
    use super::*;

    #[test]
    fn malformed_output_diagnostics_never_contain_response_contents() {
        let secret = "private-token-and-message";
        for bytes in [
            Vec::new(),
            format!("\u{feff}{secret}").into_bytes(),
            format!("{{\"token\":\"{secret}\"").into_bytes(),
            vec![0xff, 0xfe],
        ] {
            let diagnostic = output_diagnostic(&bytes, false, Some(2));
            assert_eq!(diagnostic["stdoutBytes"], bytes.len());
            assert_eq!(diagnostic["exitSuccess"], false);
            assert_eq!(diagnostic["exitCode"], 2);
            assert!(!diagnostic.to_string().contains(secret));
            assert!(diagnostic["jsonError"].is_string());
        }
        let bom = output_diagnostic(b"\xef\xbb\xbf{}", true, Some(0));
        assert_eq!(bom["bom"], true);
        assert_eq!(bom["utf8"], true);
        assert_eq!(bom["firstKind"], "other");
        let object = output_diagnostic(b"  {", true, Some(0));
        assert_eq!(object["firstKind"], "object");
        assert_eq!(object["jsonError"], "Eof");
        assert_eq!(
            output_diagnostic(b"\n ", true, Some(0))["firstKind"],
            "empty"
        );
    }

    #[test]
    fn connection_tool_identity_follows_the_installed_manifest_and_rejects_ambiguity() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".codex-plugin")).unwrap();
        for slug in ["dingtalk", "dingtalk-local"] {
            let connector = json!({"slug":slug,"localAuth":{"kind":"browser_oauth","health":["health"],"start":["login"],"tool":{"id":"dws","source":"bundled"}}});
            let path = root.path().join(".codex-plugin/plugin.json");
            fs::write(
                &path,
                json!({"name":"dingtalk","connectors":[connector.clone()]}).to_string(),
            )
            .unwrap();
            assert_eq!(
                connection_auth_target(root.path(), "dingtalk", &json!({"toolId":"dws"})).unwrap(),
                json!({"pluginKey":"dingtalk","connectorSlug":slug})
            );
            assert!(
                connection_auth_target(root.path(), "other", &json!({"toolId":"dws"})).is_err()
            );
            assert!(connection_auth_target(
                root.path(),
                "dingtalk",
                &json!({"toolId":"unrelated"})
            )
            .is_err());
            fs::write(
                &path,
                json!({"name":"dingtalk","connectors":[connector.clone(),connector]}).to_string(),
            )
            .unwrap();
            assert_eq!(
                connection_auth_target(root.path(), "dingtalk", &json!({"toolId":"dws"}))
                    .unwrap_err()
                    .code,
                "connection_tool_unavailable"
            );
        }
    }

    #[tokio::test]
    async fn connection_cli_rejects_oversized_stdout_before_the_process_closes_it() {
        use tokio::io::AsyncWriteExt;
        let (reader, mut writer) = tokio::io::duplex(16);
        writer.write_all(b"12345").await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), read_tool_stdout(reader, 4))
            .await
            .expect("output limit must not wait for EOF")
            .unwrap_err();
        assert_eq!(error.code, "connection_cli_response_invalid");
        drop(writer);
    }

    #[tokio::test]
    async fn connection_cli_accepts_an_exact_limit_and_reports_read_errors_without_partial_results()
    {
        assert_eq!(read_tool_stdout(&b"1234"[..], 4).await.unwrap(), b"1234");
        struct Broken;
        impl AsyncRead for Broken {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::Error::other("untrusted error detail")))
            }
        }
        let error = read_tool_stdout(Broken, 4).await.unwrap_err();
        assert_eq!(error.code, "connection_cli_failed");
        assert!(!error.message.contains("untrusted"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connection_cli_executes_arguments_literally_without_a_shell() {
        let temp = tempfile::tempdir().unwrap();
        let value = json!({"success":true,"value":"$(echo injected); `echo injected`"});
        let actual = run_tool_json(
            temp.path(),
            Path::new("/bin/echo"),
            &[value.to_string()],
            "mail",
            "account",
        )
        .await
        .unwrap();
        assert_eq!(actual, value);
    }

    #[tokio::test]
    async fn connection_cli_rejects_a_manifest_from_another_plugin_before_tool_resolution() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".codex-plugin")).unwrap();
        fs::write(
            temp.path().join(".codex-plugin/plugin.json"),
            r#"{"name":"other","connectors":[]}"#,
        )
        .unwrap();
        assert_eq!(
            run_connection_tool(temp.path(), "mail", "account", &[])
                .await
                .unwrap_err()
                .code,
            "connection_dependency_denied"
        );
    }

    #[test]
    fn connection_cli_preserves_json_and_requires_a_successful_exit() {
        let bytes = br#"{"success":true,"result":{"items":[]}}"#;
        assert_eq!(
            parse_connection_tool_output(bytes, true, "mail", "account").unwrap()["result"]
                ["items"],
            json!([])
        );
        assert_eq!(
            parse_connection_tool_output(bytes, false, "mail", "account")
                .unwrap_err()
                .code,
            "connection_cli_failed"
        );
        assert_eq!(
            parse_connection_tool_output(b"not json", true, "mail", "account")
                .unwrap_err()
                .code,
            "connection_cli_response_invalid"
        );
        assert_eq!(
            parse_connection_tool_output(&vec![b' '; 8 * 1024 * 1024 + 1], true, "mail", "account")
                .unwrap_err()
                .code,
            "connection_cli_response_invalid"
        );
    }

    #[test]
    fn connection_cli_auth_errors_keep_declared_identity_and_network_failures_are_not_login_errors()
    {
        for code in [
            "need_login",
            "AUTH_REQUIRED",
            "connector_auth_required",
            "NOT_LOGGED_IN",
        ] {
            let bytes =
                serde_json::to_vec(&json!({"success":false,"error":{"code":code}})).unwrap();
            let error =
                parse_connection_tool_output(&bytes, false, "existing-plugin", "original-slug")
                    .unwrap_err();
            assert_eq!(error.code, "connector_auth_required");
            assert_eq!(
                error.message,
                "pluginKey=existing-plugin connectorSlug=original-slug"
            );
        }
        for code in ["NETWORK_ERROR", "FORBIDDEN", "403", "SERVER_ERROR"] {
            let bytes = serde_json::to_vec(
                &json!({"success":false,"error":{"code":code,"message":"secret"}}),
            )
            .unwrap();
            let error = parse_connection_tool_output(&bytes, false, "mail", "account").unwrap_err();
            assert_eq!(error.code, "connection_cli_failed");
            assert!(!error.message.contains("secret"));
        }
    }
}
