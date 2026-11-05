//! Publish packaged system plugins into the Kind-backed marketplace.

use crate::background_jobs::plugins::{metadata, package};
use anyhow::{Context, Result, ensure};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const BUILTINS: &[&str] = &["wegent-sites", "weibo-miniapp-h5-develop-agent"];

fn convert(manifest: &Value, claude: bool) -> Value {
    let common = [
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "skills",
        "mcpServers",
        "connectors",
    ];
    let extra = [
        "commands",
        "agents",
        "hooks",
        "outputStyles",
        "lspServers",
        "experimental",
        "dependencies",
        "userConfig",
        "channels",
        "themes",
        "monitors",
    ];
    let mut result = json!({});
    for (key, value) in manifest.as_object().expect("validated plugin manifest") {
        if common.contains(&key.as_str()) || (claude && extra.contains(&key.as_str())) {
            result[key] = value.clone();
        }
    }
    if claude && !crate::json_compat::python_truthy(&result["description"]) {
        if let Some(description) = manifest["interface"]
            .get("shortDescription")
            .or_else(|| manifest["interface"].get("longDescription"))
        {
            result["description"] = description.clone();
        }
    } else if !claude {
        let mut interface = json!({});
        if crate::json_compat::python_truthy(&manifest["displayName"]) {
            interface["displayName"] = manifest["displayName"].clone();
        }
        if crate::json_compat::python_truthy(&manifest["description"]) {
            interface["shortDescription"] = manifest["description"].clone();
        }
        if interface.as_object().is_some_and(|v| !v.is_empty()) {
            result["interface"] = interface;
        }
    }
    result
}

struct Plugin {
    bytes: Vec<u8>,
    manifest: Value,
    components: Value,
    interface: Value,
}

fn load(directory: &Path, name: &str) -> Result<Plugin> {
    const CODEX: &str = ".codex-plugin/plugin.json";
    const CLAUDE: &str = ".claude-plugin/plugin.json";
    let mut entries = super::skills::directory_entries(directory, "")?;
    entries.retain(|(name, _, _)| name.split('/').next_back() != Some(".DS_Store"));
    let read = |path: &str| -> Result<Option<Value>> {
        entries
            .iter()
            .find(|(name, _, _)| name == path)
            .map(|(_, bytes, _)| serde_json::from_slice(bytes).map_err(Into::into))
            .transpose()
    };
    let codex = read(CODEX)?;
    let claude = read(CLAUDE)?;
    let source = codex
        .as_ref()
        .or(claude.as_ref())
        .context("built-in plugin manifest is missing")?
        .clone();
    ensure!(source.is_object(), "plugin manifest must be an object");
    for manifest in codex.iter().chain(claude.iter()) {
        ensure!(
            manifest["name"].as_str().map(str::trim) == Some(name),
            "built-in plugin name mismatch"
        );
    }
    let codex = codex.unwrap_or_else(|| convert(&source, false));
    let claude = convert(claude.as_ref().unwrap_or(&codex), true);
    entries.retain(|(name, _, _)| name != CODEX && name != CLAUDE);
    entries.push((CODEX.into(), serde_json::to_vec(&codex)?, 0o644));
    entries.push((CLAUDE.into(), serde_json::to_vec(&claude)?, 0o644));
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let bytes = super::skills::package(&entries)?;
    ensure!(
        bytes.len() <= package::MAXIMUM,
        "Plugin package is too large"
    );
    // Built-in publication uses the ordinary package parser, not the stricter
    // upstream security scanner. Entries were read from the selected directory.
    let mut files = std::collections::BTreeMap::new();
    for (path, content, mode) in &entries {
        package::normalize(path)?;
        files.insert(
            path.clone(),
            package::File {
                bytes: content.clone(),
                mode: *mode,
                directory: false,
                modified: None,
            },
        );
    }
    let components = metadata::components(&files, "", &codex)?;
    let interface = if codex["interface"].is_object() {
        metadata::interface(&files, "", &codex["interface"])?
    } else {
        Value::Null
    };
    Ok(Plugin {
        bytes,
        manifest: codex,
        components,
        interface,
    })
}

fn author(value: &Value) -> Value {
    if value.is_string() {
        return value.clone();
    }
    if value.is_object() {
        let name = value["name"].as_str().unwrap_or("").trim();
        let email = value["email"].as_str().unwrap_or("").trim();
        if !name.is_empty() && !email.is_empty() {
            return json!(format!("{name} <{email}>"));
        }
        if !name.is_empty() || !email.is_empty() {
            return json!(format!("{name}{email}"));
        }
    }
    Value::Null
}

pub(super) async fn publish(
    mysql: &MysqlService,
    directory: PathBuf,
    name: &'static str,
) -> Result<()> {
    let parsed = tokio::task::spawn_blocking(move || load(&directory, name)).await??;
    let digest = format!("{:x}", Sha256::digest(&parsed.bytes));
    let cleaned = regex::Regex::new(r"[^a-zA-Z0-9_.-]+")
        .unwrap()
        .replace_all(name.trim(), "-")
        .trim_matches('-')
        .to_owned();
    let name_hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    let safe = format!(
        "{}-{}",
        cleaned
            .chars()
            .take(89)
            .collect::<String>()
            .trim_end_matches('-'),
        &name_hash[..10]
    );
    mysql.with_transaction(async|tx|{
        #[derive(FromMysqlRow)]struct Existing{id:i64,payload:Json<Value>}
        let rows:Vec<Existing>=tx.fetch_all("SELECT id,json AS payload FROM kinds WHERE user_id=0 AND kind='PluginMarketplaceItem' AND namespace='default'",()).await?;
        let id=if let Some(row)=rows.iter().find(|r|r.payload.0["spec"]["name"]==name) {row.id}else{super::insert_kind(tx,"PluginMarketplaceItem",&safe,"default",&json!({})).await?};
        let manifest=&parsed.manifest;
        let display=manifest["displayName"].as_str().or_else(||manifest["interface"]["displayName"].as_str()).unwrap_or(name);
        let description=manifest["description"].as_str().or_else(||manifest["interface"]["shortDescription"].as_str()).or_else(||manifest["interface"]["longDescription"].as_str()).unwrap_or("");
        let payload=json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginMarketplaceItem","metadata":{"name":safe,"namespace":"default"},"spec":{"id":id,"remotePluginId":format!("wegent~Plugin_{id}"),"name":name,"displayName":display,"description":description,"version":manifest["version"],"author":author(&manifest["author"]),"visibility":"workspace","featured":true,"manifest":manifest,"components":parsed.components,"interface":parsed.interface,"packageRef":{"storageKey":format!("skill-binaries/{id}"),"checksum":format!("sha256:{digest}"),"sizeBytes":parsed.bytes.len()},"sourcePayload":{"filename":format!("{name}.zip")},"ownerUserId":0},"status":{"state":"Available"}});
        tx.execute("UPDATE kinds SET json=?,is_active=1,updated_at=NOW() WHERE id=?",(Json(payload),id)).await?;
        super::skills::binary(tx,id,&parsed.bytes,parsed.bytes.len() as i64,&digest,&format!("{name}.zip"),"plugin").await
    }).await?;
    Ok(())
}

pub(super) async fn apply(mysql: &MysqlService) -> Result<()> {
    // Both currently registered built-ins are optional; no absent package is fabricated.
    #[derive(FromMysqlRow)]
    struct Existing {
        id: i64,
        payload: Json<Value>,
    }
    let legacy:Vec<Existing>=mysql.fetch_all("SELECT id,json AS payload FROM kinds WHERE kind='PluginMarketplaceItem' AND namespace='default' AND user_id<>0 AND is_active=1",()).await?;
    for row in legacy {
        if row.payload.0["spec"]["name"]
            .as_str()
            .is_some_and(|name| BUILTINS.contains(&name))
        {
            mysql
                .execute(
                    "UPDATE kinds SET is_active=0,updated_at=NOW() WHERE id=?",
                    (row.id,),
                )
                .await?;
        }
    }
    let configured = PathBuf::from(
        crate::config::env_or_dotenv("BUILTIN_PLUGINS_DIR")
            .unwrap_or("/app/init_data/plugins".into()),
    );
    let directory = if configured.is_dir() || !configured.is_absolute() {
        configured
    } else {
        PathBuf::from("init_data/plugins")
    };
    for &name in BUILTINS {
        if directory.join(name).is_dir() {
            publish(mysql, directory.join(name), name).await?;
        }
    }
    Ok(())
}
