// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

const DEFAULT_SKILL_DOWNLOAD_CONCURRENCY: usize = 3;
const SKILL_DOWNLOAD_CONCURRENCY_ENV: &str = "WEGENT_SKILL_DOWNLOAD_CONCURRENCY";

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
}
