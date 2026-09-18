//! org_department entity resolution for the skills-download path.
//!
//! Mirrors `wecode.service.erp_entity_resolver.ErpEntityResolver`:
//! `match_entity_bindings` resolves the user's ERP employee id (ssn)
//! through `wecode_erp_user`, lazily syncing the profile from the ERP
//! OpenSearch API (`/api/open/search`) under the Redis distributed lock
//! `wegent:lock:erp_profile_sync:{user_id}`, then checks department
//! membership through the shared ERP client's membership cache.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use wegent_backend_rs::erp_provider::ErpProvider;

/// `ErpEntityResolver._read_profile_employee_id`: the full `WecodeErpUser`
/// projection (`db.query(WecodeErpUser)` rendering with `wecode_erp_user_*`
/// aliases), returning the employee id when non-empty.
const ERP_PROFILE_QUERY: &str = "SELECT wecode_erp_user.id AS wecode_erp_user_id, \
     wecode_erp_user.user_id AS wecode_erp_user_user_id, \
     wecode_erp_user.employee_id AS wecode_erp_user_employee_id, \
     wecode_erp_user.department_name AS wecode_erp_user_department_name, \
     wecode_erp_user.erp_name AS wecode_erp_user_erp_name, \
     wecode_erp_user.email AS wecode_erp_user_email, \
     wecode_erp_user.last_synced_at AS wecode_erp_user_last_synced_at, \
     wecode_erp_user.created_at AS wecode_erp_user_created_at, \
     wecode_erp_user.updated_at AS wecode_erp_user_updated_at \
     FROM wecode_erp_user \
     WHERE wecode_erp_user.user_id = ? LIMIT 1";

/// The users-by-id full projection behind `_get_user_ssn`'s email lookup
/// (`db.query(User).filter(User.id == user_id)`).
const USER_EMAIL_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users WHERE users.id = ? LIMIT 1";

pub async fn resolve_employee_id<M: Mysql, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    erp: &dyn ErpProvider<R>,
    user_id: i32,
) -> MysqlResult<Option<String>> {
    if let Some(ssn) = erp_profile_employee_id(mysql, user_id).await? {
        return Ok(Some(ssn));
    }
    // Resolve the user email before taking the lock, exactly like the
    // source (no db connection is held across the ERP network call).
    let Some(email) = user_email_by_id(mysql, user_id).await? else {
        return Ok(None);
    };
    let Some(redis) = redis else {
        // The source's DistributedLock is fail-open without Redis, but
        // the ERP membership cache needs it too; without a client the
        // sync still runs once.
        let employee = erp.search_employee(&email).await;
        return Ok(employee.and_then(|employee| employee.ssn));
    };
    let lock_key = format!("wegent:lock:erp_profile_sync:{}", user_id);
    // `SET key 1 NX EX 30` (`DistributedLock.acquire`).
    let options = brz_redis::SetOptions::default()
        .with_expiration(brz_redis::SetExpiration::Seconds(30))
        .if_absent();
    let acquired = redis.set_with(lock_key.as_str(), "1", options).await;
    if !acquired.unwrap_or(true) {
        // Another worker holds the lock; the source backs off (0.5/1.0/
        // 2.0 seconds) and retries the profile read before giving up.
        for delay_ms in [500_u64, 1000, 2000] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            if let Some(ssn) = erp_profile_employee_id(mysql, user_id).await? {
                return Ok(Some(ssn));
            }
        }
        return Ok(None);
    }
    // Double-check after acquiring the lock.
    if let Some(ssn) = erp_profile_employee_id(mysql, user_id).await? {
        let _: Result<i64, _> = redis.del(lock_key.as_str()).await;
        return Ok(Some(ssn));
    }
    let employee = erp.search_employee(&email).await;
    // `DistributedLock.release` always deletes the key.
    let _: Result<i64, _> = redis.del(lock_key.as_str()).await;
    Ok(employee.and_then(|employee| employee.ssn.filter(|ssn| !ssn.is_empty())))
}

async fn erp_profile_employee_id<M>(mysql: &M, user_id: i32) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct ProfileRow {
        wecode_erp_user_employee_id: String,
    }
    let row: Option<ProfileRow> = mysql.fetch_optional(ERP_PROFILE_QUERY, (user_id,)).await?;
    Ok(row.and_then(|row| {
        let value = row.wecode_erp_user_employee_id.trim().to_string();
        (!value.is_empty()).then_some(value)
    }))
}

async fn user_email_by_id<M>(mysql: &M, user_id: i32) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct UserEmailRow {
        users_email: Option<String>,
    }
    let row: Option<UserEmailRow> = mysql.fetch_optional(USER_EMAIL_QUERY, (user_id,)).await?;
    Ok(row
        .and_then(|row| row.users_email)
        .and_then(|email| (!email.trim().is_empty()).then(|| email.trim().to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recorded ERP lazy-sync flow's SQL projections: the
    /// `wecode_erp_user` and `users` full-model queries are rendered with
    /// their `<table>_<column>` aliases, exactly like the SQLAlchemy
    /// `db.query(Model)` forms the source issues.
    #[test]
    fn erp_lazy_sync_queries_use_model_aliases() {
        // `db.query(WecodeErpUser).filter(WecodeErpUser.user_id == ...)`.
        assert!(
            ERP_PROFILE_QUERY
                .contains("wecode_erp_user.employee_id AS wecode_erp_user_employee_id")
        );
        assert!(ERP_PROFILE_QUERY.contains("FROM wecode_erp_user"));
        // `db.query(User).filter(User.id == ...)`.
        assert!(USER_EMAIL_QUERY.contains("users.email AS users_email"));
        assert!(USER_EMAIL_QUERY.contains("FROM users"));
    }
}
