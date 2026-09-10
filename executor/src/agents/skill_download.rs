// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

use uuid::Uuid;

use crate::logging::log_executor_event;

const DEFAULT_SKILL_DOWNLOAD_CONCURRENCY: usize = 3;
const SKILL_DOWNLOAD_CONCURRENCY_ENV: &str = "WEGENT_SKILL_DOWNLOAD_CONCURRENCY";
pub(crate) const REQUEST_ID_HEADER: &str = "X-Request-ID";
pub(crate) const SKILL_ID_HEADER: &str = "X-Wegent-Skill-Id";
pub(crate) const SKILL_NAME_HEADER: &str = "X-Wegent-Skill-Name";
pub(crate) const CACHE_SOURCE_HEADER: &str = "X-Wegent-Skill-Cache-Source";
pub(crate) const BACKEND_TIME_HEADER: &str = "X-Wegent-Backend-Time-Ms";
pub(crate) const GATEWAY_UPSTREAM_TIME_HEADER: &str = "X-Wegent-Gateway-Upstream-Time-Ms";

static SKILL_DOWNLOAD_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct SkillDownloadObservation {
    skill_id: i64,
    skill_name: String,
    request_id: String,
    started_at: Instant,
    inflight: usize,
}

pub(crate) struct SkillDownloadOutcome<'a> {
    pub(crate) cache_source: &'a str,
    pub(crate) bytes: usize,
    pub(crate) result: &'a str,
    pub(crate) upstream_time_ms: f64,
    pub(crate) upstream_status: Option<u16>,
    pub(crate) backend_time_ms: Option<f64>,
    pub(crate) response_request_id: Option<&'a str>,
}

impl SkillDownloadObservation {
    pub(crate) fn begin(skill_id: i64, skill_name: &str) -> Self {
        Self {
            skill_id,
            skill_name: skill_name.to_owned(),
            request_id: format!("skill-download-{}", Uuid::new_v4().simple()),
            started_at: Instant::now(),
            inflight: SKILL_DOWNLOAD_INFLIGHT.fetch_add(1, Ordering::Relaxed) + 1,
        }
    }

    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn finish(self, outcome: SkillDownloadOutcome<'_>) {
        let fields = skill_download_fields(SkillDownloadFields {
            skill_id: Some(self.skill_id),
            skill_name: &self.skill_name,
            cache_source: outcome.cache_source,
            bytes: outcome.bytes,
            duration_ms: self.started_at.elapsed().as_secs_f64() * 1000.0,
            result: outcome.result,
            inflight: self.inflight,
            upstream_time_ms: Some(outcome.upstream_time_ms),
            upstream_status: outcome.upstream_status,
            backend_time_ms: outcome.backend_time_ms,
            request_id: outcome.response_request_id.unwrap_or(&self.request_id),
        });
        log_executor_event("skill download observed", &fields);
    }
}

impl Drop for SkillDownloadObservation {
    fn drop(&mut self) {
        SKILL_DOWNLOAD_INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) fn log_skill_cache_observation(
    skill_id: Option<i64>,
    skill_name: &str,
    started_at: Instant,
    result: &str,
) {
    let fields = skill_download_fields(SkillDownloadFields {
        skill_id,
        skill_name,
        cache_source: "executor_local",
        bytes: 0,
        duration_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        result,
        inflight: SKILL_DOWNLOAD_INFLIGHT.load(Ordering::Relaxed),
        upstream_time_ms: None,
        upstream_status: None,
        backend_time_ms: None,
        request_id: "none",
    });
    log_executor_event("skill download observed", &fields);
}

struct SkillDownloadFields<'a> {
    skill_id: Option<i64>,
    skill_name: &'a str,
    cache_source: &'a str,
    bytes: usize,
    duration_ms: f64,
    result: &'a str,
    inflight: usize,
    upstream_time_ms: Option<f64>,
    upstream_status: Option<u16>,
    backend_time_ms: Option<f64>,
    request_id: &'a str,
}

fn skill_download_fields(values: SkillDownloadFields<'_>) -> Vec<(&'static str, String)> {
    vec![
        (
            "skill_id",
            values
                .skill_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_owned()),
        ),
        ("skill_name", values.skill_name.to_owned()),
        ("cache_source", values.cache_source.to_owned()),
        ("bytes", values.bytes.to_string()),
        ("duration_ms", format!("{:.2}", values.duration_ms)),
        ("result", values.result.to_owned()),
        ("inflight", values.inflight.to_string()),
        (
            "upstream_time_ms",
            values
                .upstream_time_ms
                .map(|value| format!("{value:.2}"))
                .unwrap_or_else(|| "none".to_owned()),
        ),
        (
            "upstream_status",
            values
                .upstream_status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unavailable".to_owned()),
        ),
        (
            "backend_time_ms",
            values
                .backend_time_ms
                .map(|value| format!("{value:.2}"))
                .unwrap_or_else(|| "unavailable".to_owned()),
        ),
        ("request_id", safe_header_value(values.request_id)),
    ]
}

pub(crate) fn response_milliseconds(value: Option<&reqwest::header::HeaderValue>) -> Option<f64> {
    value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
}

pub(crate) fn response_request_id(value: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(safe_header_value)
        .filter(|value| !value.is_empty())
}

pub(crate) fn encoded_skill_name(skill_name: &str) -> String {
    url::form_urlencoded::byte_serialize(skill_name.as_bytes()).collect()
}

fn safe_header_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect()
}

pub(crate) fn skill_download_concurrency() -> usize {
    env::var(SKILL_DOWNLOAD_CONCURRENCY_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SKILL_DOWNLOAD_CONCURRENCY)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        old_value: Option<String>,
    }

    impl EnvGuard {
        fn set(value: &str) -> Self {
            let old_value = env::var(SKILL_DOWNLOAD_CONCURRENCY_ENV).ok();
            env::set_var(SKILL_DOWNLOAD_CONCURRENCY_ENV, value);
            Self { old_value }
        }

        fn remove() -> Self {
            let old_value = env::var(SKILL_DOWNLOAD_CONCURRENCY_ENV).ok();
            env::remove_var(SKILL_DOWNLOAD_CONCURRENCY_ENV);
            Self { old_value }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                env::set_var(SKILL_DOWNLOAD_CONCURRENCY_ENV, value);
            } else {
                env::remove_var(SKILL_DOWNLOAD_CONCURRENCY_ENV);
            }
        }
    }

    #[test]
    fn skill_download_concurrency_defaults_to_three() {
        let _lock = crate::test_env::lock();
        let _guard = EnvGuard::remove();

        assert_eq!(skill_download_concurrency(), 3);
    }

    #[test]
    fn skill_download_concurrency_uses_env_override() {
        let _lock = crate::test_env::lock();
        let _guard = EnvGuard::set("7");

        assert_eq!(skill_download_concurrency(), 7);
    }

    #[test]
    fn skill_download_concurrency_ignores_invalid_env() {
        let _lock = crate::test_env::lock();
        let _guard = EnvGuard::set("0");

        assert_eq!(skill_download_concurrency(), 3);
    }

    #[test]
    fn observation_fields_cover_download_correlation_without_credentials() {
        let fields = skill_download_fields(SkillDownloadFields {
            skill_id: Some(110603),
            skill_name: "wegent-knowledge",
            cache_source: "skill_binary",
            bytes: 4096,
            duration_ms: 125.25,
            result: "success",
            inflight: 3,
            upstream_time_ms: Some(120.5),
            upstream_status: Some(200),
            backend_time_ms: Some(80.0),
            request_id: "skill-download-request",
        });

        assert_eq!(
            fields,
            vec![
                ("skill_id", "110603".to_owned()),
                ("skill_name", "wegent-knowledge".to_owned()),
                ("cache_source", "skill_binary".to_owned()),
                ("bytes", "4096".to_owned()),
                ("duration_ms", "125.25".to_owned()),
                ("result", "success".to_owned()),
                ("inflight", "3".to_owned()),
                ("upstream_time_ms", "120.50".to_owned()),
                ("upstream_status", "200".to_owned()),
                ("backend_time_ms", "80.00".to_owned()),
                ("request_id", "skill-download-request".to_owned()),
            ]
        );
        assert!(fields.iter().all(|(key, _)| !key.contains("token")));
    }

    #[test]
    fn encoded_skill_name_is_safe_for_request_headers() {
        assert_eq!(
            encoded_skill_name("知识库 Skill"),
            "%E7%9F%A5%E8%AF%86%E5%BA%93+Skill"
        );
    }
}
