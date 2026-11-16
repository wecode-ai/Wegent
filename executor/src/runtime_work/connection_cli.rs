//! Host-declared CLI reads reuse exact installed plugin tools, never arbitrary executables.
use super::connection_dependencies::installed_dependency;
use crate::{agents::CodexAppServerClient, local::app_ipc::AppIpcError};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) async fn request(
    client: &CodexAppServerClient,
    payload: Value,
    declaration: Value,
) -> Result<Value, AppIpcError> {
    if payload["operation"] != "callTool" && payload["operation"] != "describe" {
        return Err(denied());
    }
    let installed = client
        .request("plugin/installed", serde_json::json!({"cwds":[]}))
        .await
        .map_err(|_| {
            AppIpcError::new(
                "dependency_unavailable",
                "Cannot read Codex dependency inventory",
            )
        })?;
    let plugin = installed_dependency(&installed, &payload)?;
    let root = dependency_root(
        &plugin,
        &payload["source"],
        &crate::agents::wework_codex_home(),
    )?;
    let key = plugin["name"].as_str().ok_or_else(denied)?;
    let target = super::local_connector_auth::connection_auth_target(&root, key, &declaration)?;
    if payload["operation"] == "describe" {
        return Ok(target);
    }
    let mut args = read_arguments(&declaration, &payload)?;
    let output = temporary_output(&declaration, &payload, &mut args)?;
    let slug = target["connectorSlug"].as_str().ok_or_else(denied)?;
    let result = super::local_connector_auth::run_connection_tool(&root, key, slug, &args)
        .await
        .map_err(collection_read_error)
        .inspect_err(|error| {
            if error.code == "connection_cli_response_invalid" {
                crate::logging::log_executor_event(
                    "Connection read output rejected",
                    &[
                        (
                            "provider",
                            payload["providerId"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        ),
                        (
                            "operation",
                            payload["tool"].as_str().unwrap_or_default().to_owned(),
                        ),
                    ],
                );
            }
        })?;
    match output {
        Some(file) => publish_output(file, &result),
        None => Ok(result),
    }
}

fn temporary_output(
    declaration: &Value,
    payload: &Value,
    args: &mut Vec<String>,
) -> Result<Option<tempfile::NamedTempFile>, AppIpcError> {
    let spec = &declaration["operations"][payload["tool"].as_str().ok_or_else(denied)?];
    let Some(output) = spec.get("outputFile") else {
        return Ok(None);
    };
    let flag = output["flag"]
        .as_str()
        .filter(|flag| {
            flag.starts_with("--")
                && flag.len() > 2
                && flag[2..]
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !args.iter().any(|arg| arg.split('=').next() == Some(*flag))
        })
        .ok_or_else(denied)?;
    let file = tempfile::Builder::new()
        .prefix("wework-source-image-")
        .suffix(".png")
        .tempfile()
        .map_err(|_| output_error())?;
    args.extend([
        flag.to_owned(),
        file.path().to_str().ok_or_else(output_error)?.to_owned(),
    ]);
    Ok(Some(file))
}

fn output_error() -> AppIpcError {
    AppIpcError::new(
        "connection_cli_response_invalid",
        "The source download did not produce a valid temporary file",
    )
}

fn publish_output(file: tempfile::NamedTempFile, result: &Value) -> Result<Value, AppIpcError> {
    if result["success"] == false || result["ok"] == false {
        return Err(output_error());
    }
    let metadata = std::fs::symlink_metadata(file.path()).map_err(|_| output_error())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(output_error());
    }
    let path = file.into_temp_path().keep().map_err(|_| output_error())?;
    // Return only the host-owned path, never signed download URLs or account data.
    Ok(serde_json::json!({"path":path,"readOnly":true}))
}

pub(super) fn collection_read_error(error: AppIpcError) -> AppIpcError {
    // Only host-declared reads receive recovery hints for process, transport or
    // generic request failures. Permission and protocol rejections remain stopped.
    if matches!(
        error.code.as_str(),
        "connection_cli_failed" | "connection_cli_timeout" | "connection_cli_request_unavailable"
    ) {
        error.with_retry_after_ms(30_000)
    } else {
        error
    }
}

fn denied() -> AppIpcError {
    AppIpcError::new(
        "connection_tool_denied",
        "Only declared plugin read operations and parameters are allowed",
    )
}

fn read_arguments(declaration: &Value, payload: &Value) -> Result<Vec<String>, AppIpcError> {
    let operation = payload["tool"].as_str().ok_or_else(denied)?;
    let spec = &declaration["operations"][operation];
    let strings = |items: &Value| -> Result<Vec<String>, AppIpcError> {
        items
            .as_array()
            .ok_or_else(denied)?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(denied)
            })
            .collect()
    };
    let mut args = strings(&spec["command"])?;
    if args.is_empty() {
        return Err(denied());
    }
    let parameters = spec["parameters"].as_object().ok_or_else(denied)?;
    for (name, value) in payload["arguments"].as_object().ok_or_else(denied)? {
        let flag = parameters
            .get(name)
            .and_then(Value::as_str)
            .filter(|flag| flag.starts_with("--"))
            .ok_or_else(denied)?;
        let value = value
            .as_str()
            .filter(|s| {
                !s.is_empty() && !s.starts_with('-') && !s.contains('\0') && s.len() <= 4096
            })
            .ok_or_else(denied)?;
        args.extend([flag.to_owned(), value.to_owned()]);
    }
    args.extend(strings(&declaration["outputArgs"])?);
    if args.len() > 64 {
        return Err(denied());
    }
    Ok(args)
}

pub(super) fn dependency_root(
    plugin: &Value,
    source: &Value,
    home: &Path,
) -> Result<PathBuf, AppIpcError> {
    if let Some(version) = plugin["localVersion"].as_str() {
        let parts = [
            source["marketplaceId"].as_str(),
            plugin["name"].as_str(),
            Some(version),
        ];
        let mut root = home.join("plugins/cache");
        for part in parts {
            let part = part.ok_or_else(denied)?;
            let mut components = Path::new(part).components();
            if !matches!(components.next(), Some(Component::Normal(_)))
                || components.next().is_some()
            {
                return Err(denied());
            }
            root.push(part);
        }
        return Ok(root);
    }
    if plugin["source"]["type"] == "local" {
        if let Some(path) = plugin["source"]["path"]
            .as_str()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        {
            return Ok(path);
        }
    }
    Err(AppIpcError::new(
        "dependency_unavailable",
        "The exact installed plugin root is unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn declaration() -> Value {
        json!({"connectorSlug":"account","outputArgs":["--format","json"],"operations":{"search":{"command":["chat","search"],"parameters":{"query":"--query","profile":"--profile"}}}})
    }
    #[test]
    fn source_download_paths_are_host_owned_and_empty_or_failed_outputs_are_removed() {
        let declaration = serde_json::json!({"outputArgs":["--format","json"],"operations":{
            "image":{"command":["download"],"parameters":{"resource":"--resource"},
            "outputFile":{"flag":"--output"}}
        }});
        let input = serde_json::json!({"tool":"image","arguments":{"resource":"image"}});
        let mut args = read_arguments(&declaration, &input).unwrap();
        let file = temporary_output(&declaration, &input, &mut args)
            .unwrap()
            .unwrap();
        let path = file.path().to_owned();
        assert_eq!(args[args.len() - 2], "--output");
        assert_eq!(Path::new(args.last().unwrap()), path);
        assert!(publish_output(file, &serde_json::json!({"success":true})).is_err());
        assert!(!path.exists());
        let mut malicious = input.clone();
        malicious["arguments"]["output"] = serde_json::json!("/arbitrary/file");
        assert!(read_arguments(&declaration, &malicious).is_err());

        let mut args = read_arguments(&declaration, &input).unwrap();
        let file = temporary_output(&declaration, &input, &mut args)
            .unwrap()
            .unwrap();
        std::fs::write(file.path(), b"downloaded-image").unwrap();
        let result = publish_output(
            file,
            &serde_json::json!({"success":true,"downloadUrl":"private-signed-url"}),
        )
        .unwrap();
        assert_eq!(result["readOnly"], true);
        assert!(result.get("downloadUrl").is_none());
        let path = result["path"].as_str().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"downloaded-image");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn connection_cli_only_accepts_host_declared_operations_and_parameters() {
        let input =
            json!({"tool":"search","arguments":{"profile":"corp:user","query":"hello world"}});
        assert_eq!(
            read_arguments(&declaration(), &input).unwrap(),
            vec![
                "chat",
                "search",
                "--profile",
                "corp:user",
                "--query",
                "hello world",
                "--format",
                "json"
            ]
        );
        for input in [
            json!({"tool":"reply","arguments":{}}),
            json!({"tool":"search","arguments":{"output":"/tmp/file"}}),
            json!({"tool":"search","arguments":{"query":"--export"}}),
            json!({"tool":"search","arguments":{"query":42}}),
        ] {
            assert_eq!(
                read_arguments(&declaration(), &input).unwrap_err().code,
                "connection_tool_denied"
            );
        }
        assert!(read_arguments(&Value::Null, &input).is_err());
    }
    #[test]
    fn connection_cli_resolves_only_the_exact_installed_cache_version_or_declared_local_source() {
        let plugin = json!({"name":"mail","localVersion":"1.2.0"});
        let source = json!({"marketplaceId":"company","pluginId":"mail@company"});
        assert_eq!(
            dependency_root(&plugin, &source, Path::new("/managed")).unwrap(),
            Path::new("/managed/plugins/cache/company/mail/1.2.0")
        );
        for (key, value) in [("name", "../mail"), ("localVersion", "../other")] {
            let mut invalid = plugin.clone();
            invalid[key] = json!(value);
            assert!(dependency_root(&invalid, &source, Path::new("/managed")).is_err());
        }
        assert!(dependency_root(
            &plugin,
            &json!({"marketplaceId":"../other"}),
            Path::new("/managed")
        )
        .is_err());
        let local = json!({"name":"mail","source":{"type":"local","path":"/plugins/mail"}});
        assert_eq!(
            dependency_root(&local, &source, Path::new("/managed")).unwrap(),
            Path::new("/plugins/mail")
        );
        assert!(dependency_root(&json!({"name":"mail"}), &source, Path::new("/managed")).is_err());
    }
}
