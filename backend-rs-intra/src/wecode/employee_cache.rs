//! Source-compatible cache-only membership lookup.
use std::collections::BTreeMap;
pub async fn cached_membership<R>(
    redis: Option<&R>,
    user_id: i64,
    ssn: &str,
    dept_ids: &[String],
) -> Vec<String>
where
    R: brz_redis::Redis,
{
    let Some(redis) = redis else {
        return Vec::new();
    };
    let key = format!("erp:membership:{user_id}:{ssn}");
    let value: Option<brz_redis::RedisBytes> = match redis.get(key.as_str()).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, %key, "[erp_cache] membership cache read failed");
            return Vec::new();
        }
    };
    let Some(bytes) = value else {
        return Vec::new();
    };
    membership_from_bytes(bytes.as_ref(), dept_ids)
}

fn membership_from_bytes(bytes: &[u8], dept_ids: &[String]) -> Vec<String> {
    let Ok(map) = serde_json::from_slice::<BTreeMap<String, Option<bool>>>(bytes) else {
        return Vec::new();
    };
    dept_ids
        .iter()
        .filter(|dept| map.get(dept.as_str()).copied().flatten() == Some(true))
        .cloned()
        .collect()
}
