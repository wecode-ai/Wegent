//! Source-compatible startup initialization before any background consumer starts.

use anyhow::{Context, Result};
use brz_mysql::MysqlService;
use brz_redis::{Redis, RedisService, SetExpiration, SetOptions};

const KEY: &str = "wegent:startup_lock";

pub async fn prepare(mysql: &MysqlService, redis: Option<&RedisService>) -> Result<()> {
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
    crate::initialization::plugins(mysql).await
}
