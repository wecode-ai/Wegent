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
    if payload["operation"] != "callTool" {
        return Err(denied());
    }
    let args = read_arguments(&declaration, &payload)?;
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
    let slug = declaration["connectorSlug"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(denied)?;
    super::local_connector_auth::run_connection_tool(
        &root,
        plugin["name"].as_str().ok_or_else(denied)?,
        slug,
        &args,
    )
    .await
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

fn dependency_root(plugin: &Value, source: &Value, home: &Path) -> Result<PathBuf, AppIpcError> {
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
