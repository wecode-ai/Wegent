//! ERP OpenSearch membership client with the source Redis cache contract.
//!
//! Ported from `wecode/service/erp_client.py` and
//! `wecode/service/erp_entity_resolver.py`: department membership is checked
//! in chunks of 50 through `/api/open/batch-check-membership` with a
//! client-token OAuth handshake, and results are cached under
//! `erp:membership:{user_id}:{ssn}` for 15 minutes.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_redis::RedisBytes;
use serde::{Deserialize, Serialize, ser::SerializeMap};
use tokio::sync::Mutex;

use super::erp_config::AppConfig;
use wegent_backend_rs::erp_types::EmployeeInfo;

#[derive(Serialize)]
struct MembershipRequest<'a> {
    ssn: &'a str,
    department_ids: &'a [String],
}

/// Preserve requested key insertion order and emit duplicate departments once,
/// matching the previous JSON map used for the Redis payload.
struct OrderedMembership<'a> {
    value: &'a BTreeMap<String, bool>,
    order: &'a [String],
}

impl Serialize for OrderedMembership<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        let mut seen = BTreeSet::new();
        for dept in self.order {
            if let Some(value) = self.value.get(dept)
                && seen.insert(dept)
            {
                map.serialize_entry(dept, value)?;
            }
        }
        map.end()
    }
}

const CACHE_TTL_SECONDS: u64 = 900;
const MEMBERSHIP_CHUNK_SIZE: usize = 50;
/// The source drops a cached token 60 seconds before its real expiry
/// (`time.time() < self._token_expires_at - 60`).
const TOKEN_EARLY_EXPIRY_SECONDS: i64 = 60;
/// The source defaults `expires_in` to 1800 seconds when the token response
/// omits it.
const TOKEN_DEFAULT_EXPIRES_IN: i64 = 1800;

#[derive(Clone)]
pub struct ErpClient {
    base_url: String,
    client_id: String,
    client_secret: String,
    http: HttpClient,
    /// In-process access-token cache mirroring `ErpClient._access_token` /
    /// `_token_expires_at`. Shared by every clone (the client is cloned into
    /// the request state), like the source's module-level client instance.
    token: Arc<Mutex<Option<TokenState>>>,
}

/// A cached OAuth access token and its expiry.
struct TokenState {
    token: String,
    /// Unix-seconds expiry as returned by `expires_in` (already absolute).
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    data: TokenData,
}

#[derive(Debug, Deserialize)]
struct TokenData {
    access_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct MembershipResponse {
    data: MembershipData,
}

#[derive(Debug, Deserialize)]
struct MembershipData {
    #[serde(default)]
    results: Vec<MembershipResult>,
}

/// A batch-membership result entry: `department_id` arrives as either a
/// string or a number (the source coerces with `str(raw_dept_id)`).
#[derive(Debug, Deserialize)]
struct MembershipResult {
    department_id: Option<DepartmentId>,
    is_member: Option<bool>,
}

/// `department_id` in the ERP API responses: a JSON string or number,
/// normalized to its string form (`str(raw_dept_id)` in the source).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DepartmentId {
    Text(String),
    Number(serde_json::Number),
}

impl DepartmentId {
    /// The normalized string key (`str(raw_dept_id)`).
    fn to_key(&self) -> Option<String> {
        match self {
            Self::Text(value) => Some(value.clone()),
            Self::Number(value) => Some(value.to_string()),
        }
    }
}

/// `/api/open/search` response payload (`ErpClient._search`).
#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    data: SearchData,
}

#[derive(Debug, Default, Deserialize)]
struct SearchData {
    #[serde(default)]
    #[allow(dead_code)]
    keyword: Option<String>,
    #[serde(default)]
    employees: Vec<EmployeeInfo>,
}

impl ErpClient {
    pub fn new(config: &AppConfig) -> Self {
        let http = HttpClient::builder()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| HttpClient::builder().build().expect("default HTTP client"));
        Self {
            base_url: config.erp_opensearch_base_url.clone(),
            client_id: config.erp_client_id.clone(),
            client_secret: config.erp_client_secret.clone(),
            http,
            token: Arc::new(Mutex::new(None)),
        }
    }

    pub fn configured(&self) -> bool {
        !self.base_url.is_empty() && !self.client_id.is_empty() && !self.client_secret.is_empty()
    }

    /// Check which departments the employee belongs to, honoring the cache
    /// first exactly like `_get_membership_with_cache`.
    ///
    /// The cache payload is rebuilt scoped to the current request's
    /// `dept_ids` only (the source rebuilds `fresh` from `dept_ids`, dropping
    /// stale entries from earlier requests), and the payload preserves the
    /// `dept_ids` insertion order like the source dict.
    pub async fn membership_with_cache(
        &self,
        redis: Option<&impl brz_redis::Redis>,
        user_id: i32,
        ssn: &str,
        dept_ids: &[String],
    ) -> Vec<String> {
        if dept_ids.is_empty() {
            return Vec::new();
        }
        let cache_key = format!("erp:membership:{user_id}:{ssn}");
        let cached = Self::cache_get(redis, &cache_key).await;
        if let Some(cached) = cached {
            let missing: Vec<&String> = dept_ids
                .iter()
                .filter(|dept| !cached.contains_key(*dept))
                .collect();
            if missing.is_empty() {
                return dept_ids
                    .iter()
                    .filter(|dept| cached.get(*dept).copied().unwrap_or(false))
                    .cloned()
                    .collect();
            }
            // Partial hit: query only the missing departments and rebuild a
            // fresh cache scoped to this request.
            let missing_owned: Vec<String> = missing.into_iter().cloned().collect();
            let fresh_api = self.batch_check_membership(ssn, &missing_owned).await;
            // `fresh: dict = {d: result.get(d, cached.get(d, False)) for d
            // in dept_ids}` — keys only for the requested departments, in
            // request order.
            let mut fresh: BTreeMap<String, bool> = BTreeMap::new();
            let mut order: Vec<String> = Vec::with_capacity(dept_ids.len());
            for dept in dept_ids {
                let value = match fresh_api.get(dept.as_str()) {
                    Some(value) => *value,
                    None => cached.get(dept.as_str()).copied().unwrap_or(false),
                };
                fresh.insert(dept.clone(), value);
                order.push(dept.clone());
            }
            Self::cache_set(redis, &cache_key, &fresh, &order).await;
            return order
                .into_iter()
                .filter(|dept| fresh.get(dept.as_str()).copied().unwrap_or(false))
                .collect();
        }
        let fresh = self.batch_check_membership(ssn, dept_ids).await;
        let order: Vec<String> = dept_ids.to_vec();
        Self::cache_set(redis, &cache_key, &fresh, &order).await;
        order
            .into_iter()
            .filter(|dept| fresh.get(dept.as_str()).copied().unwrap_or(false))
            .collect()
    }

    async fn cache_get(
        redis: Option<&impl brz_redis::Redis>,
        key: &str,
    ) -> Option<BTreeMap<String, bool>> {
        let redis = redis?;
        let value: Option<RedisBytes> = redis.get(key).await.ok()?;
        let bytes = value?;
        serde_json::from_slice(&bytes).ok()
    }

    async fn cache_set(
        redis: Option<&impl brz_redis::Redis>,
        key: &str,
        value: &BTreeMap<String, bool>,
        order: &[String],
    ) {
        let Some(redis) = redis else {
            return;
        };
        // Serialize in the source's insertion order (`order`), like the
        // source dict serialized by orjson.
        let payload = OrderedMembership { value, order };
        if let Ok(bytes) = serde_json::to_vec(&payload) {
            // The source cache write is best-effort: failures are logged and
            // ignored, never failing the request.
            let options = brz_redis::SetOptions::default()
                .with_expiration(brz_redis::SetExpiration::Seconds(CACHE_TTL_SECONDS));
            let _: Result<bool, _> = redis.set_with(key, bytes, options).await;
        }
    }

    /// Call the ERP batch membership API in chunks of 50, mirroring
    /// `ErpClient.batch_check_membership`: the request is sent even when the
    /// OAuth token is unavailable (the source's `_get_headers` only adds the
    /// `Authorization` header when `_ensure_token` succeeds); a failed or
    /// unconfigured client yields no matches.
    async fn batch_check_membership(
        &self,
        ssn: &str,
        dept_ids: &[String],
    ) -> BTreeMap<String, bool> {
        let mut results = BTreeMap::new();
        if !self.configured() || dept_ids.is_empty() || ssn.is_empty() {
            return results;
        }
        // `_get_headers`: the bearer token is best-effort; the request is
        // still sent without it when the token endpoint fails.
        let token = self.ensure_token().await;
        for chunk in dept_ids.chunks(MEMBERSHIP_CHUNK_SIZE) {
            let body = MembershipRequest {
                ssn,
                department_ids: chunk,
            };
            let endpoint = match self
                .http
                .endpoint(format!("{}/api/open/batch-check-membership", self.base_url))
            {
                Ok(endpoint) => endpoint,
                Err(_) => continue,
            };
            let mut request = endpoint.post().json(&body);
            if let Some(token) = token.as_deref() {
                request = request.bearer_auth(token);
            }
            let Ok(request) = request.build() else {
                continue;
            };
            let Ok(response) = self.http.execute(request).await else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            let Ok(payload) = response.json::<MembershipResponse>().await else {
                continue;
            };
            for item in payload.data.results {
                let Some(raw_id) = item.department_id else {
                    continue;
                };
                let Some(dept_id) = raw_id.to_key() else {
                    continue;
                };
                results.insert(dept_id, item.is_member.unwrap_or(false));
            }
        }
        results
    }

    /// `ErpClient.search_employee`: search by keyword (username, email, or
    /// ssn), preferring an exact case-insensitive match on ssn, name, or
    /// email and falling back to the first result. Returns `None` when the
    /// API is unconfigured, the request fails, or no employee is found.
    pub async fn search_employee(&self, keyword: &str) -> Option<EmployeeInfo> {
        if !self.configured() || keyword.is_empty() {
            return None;
        }
        // `_search`: GET `{base}/api/open/search?keyword=...` with the
        // best-effort bearer token from `_get_headers`.
        let token = self.ensure_token().await;
        let endpoint = self
            .http
            .endpoint(format!("{}/api/open/search", self.base_url))
            .ok()?;
        let mut request = endpoint.get().query(&[("keyword", keyword)]);
        if let Some(token) = token.as_deref() {
            request = request.bearer_auth(token);
        }
        let request = request.build().ok()?;
        let response = self.http.execute(request).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let payload = response.json::<SearchResponse>().await.ok()?;
        let employees = payload.data.employees;
        // The source validates every entry; a non-object entry fails the
        // whole call (`EmployeeInfo.model_validate(emp)` raises).
        let first = employees.first().cloned()?;
        let keyword_lower = keyword.to_ascii_lowercase();
        for info in &employees {
            let exact = !keyword_lower.is_empty()
                && (info
                    .ssn
                    .as_deref()
                    .is_some_and(|ssn| ssn.to_ascii_lowercase() == keyword_lower)
                    || info
                        .name
                        .as_deref()
                        .is_some_and(|name| name.to_ascii_lowercase() == keyword_lower)
                    || info
                        .email
                        .as_deref()
                        .is_some_and(|email| email.to_ascii_lowercase() == keyword_lower));
            if exact {
                return Some(info.clone());
            }
        }
        Some(first)
    }

    /// Get a valid access token, refreshing if needed, mirroring
    /// `ErpClient._ensure_token`: a cached token is reused until 60 seconds
    /// before its expiry, and failures are not cached.
    async fn ensure_token(&self) -> Option<String> {
        if !self.configured() {
            return None;
        }
        let now = chrono::Utc::now().timestamp();
        {
            let cached = self.token.lock().await;
            if let Some(state) = cached.as_ref()
                && now < state.expires_at - TOKEN_EARLY_EXPIRY_SECONDS
            {
                return Some(state.token.clone());
            }
        }
        // The source uses double-checked locking so concurrent callers do not
        // all refresh in parallel; the second check after re-acquiring the
        // mutex covers it here.
        let mut cache = self.token.lock().await;
        if let Some(state) = cache.as_ref()
            && now < state.expires_at - TOKEN_EARLY_EXPIRY_SECONDS
        {
            return Some(state.token.clone());
        }
        let endpoint = self
            .http
            .endpoint(format!("{}/api/oauth/client-token", self.base_url))
            .ok()?;
        let form = [
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
        ];
        let request = endpoint.post().form(&form).build().ok()?;
        let response = self.http.execute(request).await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let payload = response.json::<TokenResponse>().await.ok()?;
        let token = payload.data.access_token?;
        let expires_in = payload.data.expires_in.unwrap_or(TOKEN_DEFAULT_EXPIRES_IN);
        *cache = Some(TokenState {
            expires_at: now + expires_in,
            token: token.clone(),
        });
        Some(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_cache_preserves_order_duplicates_and_false_values() {
        let value = BTreeMap::from([("A".into(), false), ("B".into(), true), ("C".into(), true)]);
        let order = vec!["B".into(), "missing".into(), "A".into(), "B".into()];
        assert_eq!(
            serde_json::to_string(&OrderedMembership {
                value: &value,
                order: &order
            })
            .unwrap(),
            r#"{"B":true,"A":false}"#
        );
        assert_eq!(
            serde_json::to_string(&OrderedMembership {
                value: &value,
                order: &[]
            })
            .unwrap(),
            "{}"
        );
    }

    #[test]
    fn membership_request_preserves_empty_and_duplicate_departments() {
        for departments in [vec![], vec!["B".into(), "A".into(), "A".into(), "".into()]] {
            assert_eq!(
                crate::json_contract_tests::serialized(MembershipRequest {
                    ssn: "",
                    department_ids: &departments
                })
                .unwrap(),
                serde_json::json!({"ssn":"", "department_ids": departments})
            );
        }
    }

    #[test]
    fn decodes_employee_entries() {
        let raw = serde_json::json!({
            "ssn": "10086", "name": "n", "email": "n@api.auto", "department": "d"
        });
        let info: EmployeeInfo = serde_json::from_value(raw).unwrap();
        assert_eq!(info.ssn.as_deref(), Some("10086"));
        assert_eq!(info.email.as_deref(), Some("n@api.auto"));
        // Missing fields decode as None; empty strings decode as None.
        let empty: EmployeeInfo = serde_json::from_value(serde_json::json!({"ssn": ""})).unwrap();
        assert_eq!(empty.ssn, None);
        assert!(serde_json::from_value::<EmployeeInfo>(serde_json::json!(1)).is_err());
    }

    #[test]
    fn search_response_tolerates_missing_employees() {
        let payload: SearchResponse =
            serde_json::from_str(r#"{"code":200,"data":{"keyword":"k","employees":[]}}"#).unwrap();
        assert!(payload.data.employees.is_empty());
        assert_eq!(payload.data.keyword.as_deref(), Some("k"));
    }

    #[test]
    fn membership_department_id_accepts_string_and_number() {
        let payload: MembershipResponse = serde_json::from_str(
            r#"{"data":{"results":[
                {"department_id": "100", "is_member": true},
                {"department_id": 200, "is_member": false},
                {"department_id": null, "is_member": true}
            ]}}"#,
        )
        .unwrap();
        let results = payload.data.results;
        assert_eq!(
            results[0].department_id.as_ref().unwrap().to_key(),
            Some("100".to_string())
        );
        assert_eq!(
            results[1].department_id.as_ref().unwrap().to_key(),
            Some("200".to_string())
        );
        assert!(results[2].department_id.is_none());
    }
}
