//! Execute plugin-declared tool binaries with isolated JSON output handling.
use super::*;
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_TOOL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

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
    parse_connection_tool_output(&output.0, output.1.success(), plugin_key, connector_slug)
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
                std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "untrusted error detail",
                )))
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
