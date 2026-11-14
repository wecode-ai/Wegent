//! Default data initialization, separate from schema migrations and HTTP state.

use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};

mod connectors;
mod plugins;
mod skills;

static DIRECTORIES: OnceLock<RwLock<Vec<PathBuf>>> = OnceLock::new();

/// Extension-owned resources follow the public resource directory.
pub fn register_directory(path: PathBuf) -> Result<()> {
    let path = path.canonicalize()?;
    let mut dirs = DIRECTORIES
        .get_or_init(Default::default)
        .write()
        .expect("initialization directory registry");
    if !dirs.contains(&path) {
        dirs.push(path);
    }
    Ok(())
}

pub(crate) fn boolean(name: &str, default: bool) -> Result<bool> {
    match crate::config::env_or_dotenv(name)
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        None => Ok(default),
        Some("true" | "1" | "yes" | "on" | "y" | "t") => Ok(true),
        Some("false" | "0" | "no" | "off" | "n" | "f") => Ok(false),
        _ => bail!("{name} must be a boolean"),
    }
}

pub use wegent_backend_config::resource_directory;

#[derive(FromMysqlRow)]
pub(super) struct Kind {
    pub id: i64,
    pub payload: Json<Value>,
    pub is_active: Option<bool>,
}

pub(super) async fn kind(
    tx: &mut impl MysqlTransaction,
    resource_type: &str,
    name: &str,
    namespace: &str,
) -> brz_mysql::MysqlResult<Option<Kind>> {
    tx.fetch_optional("SELECT id,json AS payload,is_active FROM kinds WHERE user_id=0 AND kind=? AND name=? AND namespace=? LIMIT 1",(resource_type,name,namespace)).await
}

pub(super) async fn insert_kind(
    tx: &mut impl MysqlTransaction,
    resource_type: &str,
    name: &str,
    namespace: &str,
    payload: &Value,
) -> brz_mysql::MysqlResult<i64> {
    Ok(tx.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (0,?,?,?,?,1,NOW(),NOW())",(resource_type,name,namespace,Json(payload))).await?.last_insert_id as i64)
}

async fn admin(mysql: &MysqlService) -> Result<()> {
    #[derive(FromMysqlRow)]
    struct Id {
        id: i64,
    }
    let existing: Option<Id> = mysql
        .fetch_optional("SELECT id FROM users WHERE user_name='admin' LIMIT 1", ())
        .await?;
    if let Some(existing) = existing {
        tracing::debug!(id = existing.id, "initial admin already exists");
        return Ok(());
    }
    let mut random = [0; 48];
    getrandom::getrandom(&mut random).context("cannot generate initial admin secret")?;
    use base64::Engine;
    let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let password = bcrypt::hash(secret, 12).context("cannot hash initial admin secret")?;
    mysql.with_transaction(async |tx| {
        let id=tx.execute("INSERT INTO users (user_name,password_hash,email,git_info,is_active,role,auth_source,preferences,created_at,updated_at) VALUES ('admin',?,'admin@example.com','[]',1,'admin','password','{}',NOW(),NOW())",(password.as_str(),)).await?.last_insert_id;
        tx.execute("INSERT INTO system_configs (config_key,config_value,version,updated_by,created_at,updated_at) VALUES ('admin_password_initialized',?,1,?,NOW(),NOW())",("{\"completed\": false}",id)).await?;
        Ok(())
    }).await?;
    Ok(())
}

async fn public_resource(mysql: &MysqlService, resource: Value, force: bool) -> Result<()> {
    let resource_type = resource["kind"].as_str().unwrap_or("");
    if !["Shell", "Ghost", "Bot", "Team", "Template"].contains(&resource_type) {
        return Ok(());
    }
    let name = resource["metadata"]["name"]
        .as_str()
        .filter(|v| !v.is_empty())
        .context("public resource has no name")?;
    let namespace = resource["metadata"]["namespace"]
        .as_str()
        .unwrap_or("default");
    let existing = mysql
        .with_transaction(async |tx| kind(tx, resource_type, name, namespace).await)
        .await?;
    if let Some(existing) = existing {
        if !force {
            return Ok(());
        }
        mysql
            .with_transaction(async |tx| {
                tx.execute("DELETE FROM kinds WHERE id=?", (existing.id,))
                    .await?;
                Ok(())
            })
            .await?;
    }
    mysql
        .with_transaction(async |tx| {
            insert_kind(tx, resource_type, name, namespace, &resource).await?;
            Ok(())
        })
        .await?;
    Ok(())
}

async fn directory(mysql: &MysqlService, directory: &Path, force: bool) -> Result<()> {
    let mut yaml = Vec::new();
    let mut yml = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        match path.extension().and_then(|v| v.to_str()) {
            Some("yaml") => yaml.push(path),
            Some("yml") => yml.push(path),
            _ => {}
        }
    }
    yaml.sort();
    yml.sort();
    let mut resources = Vec::new();
    for path in yaml.into_iter().chain(yml) {
        let loaded = std::fs::read_to_string(&path)
            .map_err(anyhow::Error::from)
            .and_then(|text| wegent_python_compat::yaml::documents(&text));
        match loaded {
            Ok(documents) => resources.extend(documents.into_iter().filter(|v| {
                v.is_object() && v.get("kind").is_some() && v.get("metadata").is_some()
            })),
            Err(error) => {
                tracing::error!(path=%path.display(),%error,"cannot load initialization YAML")
            }
        }
    }
    if directory.join("skills").is_dir() {
        skills::apply(mysql, &directory.join("skills"), force).await?;
    }
    resources.sort_by_key(|v| {
        ["Shell", "Ghost", "Bot", "Team", "Template"]
            .iter()
            .position(|kind| Some(*kind) == v["kind"].as_str())
            .unwrap_or(99)
    });
    for resource in resources {
        if let Err(error) = public_resource(mysql, resource, force).await {
            tracing::error!(%error,"public resource initialization failed");
        }
    }
    Ok(())
}

pub async fn yaml(mysql: &MysqlService) -> Result<()> {
    if !boolean("INIT_DATA_ENABLED", true)?
        || crate::config::env_or_dotenv("ENVIRONMENT").as_deref() == Some("production")
    {
        return Ok(());
    }
    let force = boolean("INIT_DATA_FORCE", false)?;
    admin(mysql).await?;
    let mut dirs = vec![resource_directory()];
    dirs.extend(
        DIRECTORIES
            .get_or_init(Default::default)
            .read()
            .expect("initialization directory registry")
            .iter()
            .cloned(),
    );
    for path in dirs {
        if let Err(error) = directory(mysql, &path, force).await {
            tracing::error!(path=%path.display(),%error,"initialization directory failed");
        }
    }
    Ok(())
}

pub async fn plugins(mysql: &MysqlService) -> Result<()> {
    plugins::apply(mysql).await
}

pub async fn connectors(mysql: &MysqlService) -> Result<()> {
    connectors::apply(mysql).await
}

#[cfg(test)]
pub(crate) async fn test_publish_builtin(
    mysql: &MysqlService,
    directory: PathBuf,
    name: &'static str,
) -> Result<()> {
    plugins::publish(mysql, directory, name).await
}
