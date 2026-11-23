//! Source-compatible startup initialization before any background consumer starts.

use anyhow::{Context, Result};
use brz_mysql::MysqlService;
use brz_redis::{Redis, RedisService, SetExpiration, SetOptions};

const KEY: &str = "wegent:startup_lock";

pub async fn prepare(mysql: &MysqlService, redis: Option<&RedisService>) -> Result<()> {
    let owner = std::env::var("DB_INITIALIZATION_OWNER")
        .ok()
        .or_else(|| crate::config::env_or_dotenv("DB_INITIALIZATION_OWNER"));
    if !rust_owns_initialization(owner.as_deref())? {
        return Ok(());
    }
    let redis = redis.context("Redis is required for startup initialization locking")?;
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Seconds(120))
        .if_absent();
    if !redis.set_with(KEY, "locked", options).await? {
        tracing::info!("another process is initializing the database; skipping initialization");
        return Ok(());
    }
    let result = initialize(mysql).await;
    let release = redis.del(KEY).await;
    // Keep the migration failure as the primary error if releasing the lock also fails.
    if let Err(error) = &release {
        tracing::error!(%error,"cannot release startup initialization lock");
    }
    result?;
    release?;
    Ok(())
}

async fn initialize(mysql: &MysqlService) -> Result<()> {
    let environment = crate::config::env_or_dotenv("ENVIRONMENT").unwrap_or("development".into());
    if environment == "development" && crate::initialization::boolean("DB_AUTO_MIGRATE", true)? {
        crate::migrations::upgrade(mysql).await?;
    } else if environment == "production"
        && let Err(error) = crate::migrations::check(mysql).await
    {
        tracing::warn!(%error,"database migration pending; run wegent-backend-rs db upgrade before deployment");
    }
    if let Err(error) = crate::initialization::yaml(mysql).await {
        tracing::error!(%error,"YAML data initialization failed");
    }
    crate::initialization::plugins(mysql).await?;
    initialize_connectors(mysql).await;
    Ok(())
}

async fn initialize_connectors(mysql: &MysqlService) {
    let result = async {
        if crate::initialization::boolean("CONNECTOR_BUILTIN_APPS_ENABLED", true)? {
            crate::initialization::connectors(mysql).await?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "built-in connector app initialization failed; continuing startup and retrying on the next launch");
    }
}

fn rust_owns_initialization(owner: Option<&str>) -> Result<bool> {
    match owner {
        None | Some("rust") => Ok(true),
        Some("python") => Ok(false),
        Some(_) => anyhow::bail!("DB_INITIALIZATION_OWNER must be rust or python"),
    }
}

#[cfg(test)]
mod tests {
    use super::{MysqlService, initialize_connectors, rust_owns_initialization};
    use crate::sql_test_support::mysql_pool_server::capture_queries_until;
    use tokio::{net::TcpListener, sync::oneshot};

    #[tokio::test]
    async fn connector_initialization_failure_does_not_abort_startup() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = MysqlService::connect_lazy(&format!(
            "mysql://test:test@{}/test",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(capture_queries_until(listener, stopped));
        initialize_connectors(&mysql).await;
        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].contains("FROM system_configs"));
        mysql.close().await;
    }

    #[test]
    fn rust_initializes_by_default() {
        assert!(rust_owns_initialization(None).unwrap());
        assert!(rust_owns_initialization(Some("rust")).unwrap());
    }

    #[test]
    fn python_ownership_disables_rust_initialization() {
        assert!(!rust_owns_initialization(Some("python")).unwrap());
    }

    #[test]
    fn unknown_owners_are_rejected() {
        for owner in ["", "unknown", "Python", " python "] {
            assert!(rust_owns_initialization(Some(owner)).is_err());
        }
    }
}
