// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use crate::protocol::ExecutionRequest;

pub(crate) fn request_backend_url(request: &ExecutionRequest) -> Option<String> {
    env_url("WEGENT_BACKEND_URL")
        .or_else(|| {
            if is_local_mode() {
                payload_backend_url(request)
            } else {
                None
            }
        })
        .or_else(|| env_url("TASK_API_DOMAIN"))
        .or_else(|| payload_backend_url(request))
}

pub(crate) fn request_backend_url_or_default(request: &ExecutionRequest) -> String {
    request_backend_url(request).unwrap_or_else(|| "http://wegent-backend:8000".to_owned())
}

pub(crate) fn is_local_mode() -> bool {
    env::var("EXECUTOR_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("local"))
}

fn env_url(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn payload_backend_url(request: &ExecutionRequest) -> Option<String> {
    request
        .backend_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        old_value: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old_value = env::var(key).ok();
            env::set_var(key, value);
            Self { key, old_value }
        }

        fn remove(key: &'static str) -> Self {
            let old_value = env::var(key).ok();
            env::remove_var(key);
            Self { key, old_value }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                env::set_var(self.key, value);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn request_backend_url_uses_payload_before_task_api_domain_in_local_mode() {
        let _lock = crate::test_env::lock();
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
        let _task_api = EnvGuard::set("TASK_API_DOMAIN", "http://task-api.local:8000");
        let request = ExecutionRequest {
            backend_url: Some("http://payload-backend.local:8000".to_owned()),
            ..ExecutionRequest::default()
        };

        assert_eq!(
            request_backend_url(&request),
            Some("http://payload-backend.local:8000".to_owned())
        );
    }

    #[test]
    fn request_backend_url_uses_task_api_before_payload_outside_local_mode() {
        let _lock = crate::test_env::lock();
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let _mode = EnvGuard::remove("EXECUTOR_MODE");
        let _task_api = EnvGuard::set("TASK_API_DOMAIN", "http://task-api.local:8000");
        let request = ExecutionRequest {
            backend_url: Some("http://payload-backend.local:8000".to_owned()),
            ..ExecutionRequest::default()
        };

        assert_eq!(
            request_backend_url(&request),
            Some("http://task-api.local:8000".to_owned())
        );
    }
}
