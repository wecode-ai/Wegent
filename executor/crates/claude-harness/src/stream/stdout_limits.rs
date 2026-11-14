// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{ffi::OsStr, sync::OnceLock};

use crate::logging::log_executor_event;

pub(super) const CLAUDE_STDOUT_MAX_RAW_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

const MAX_BUFFER_BYTES_ENV: &str = "WEGENT_CLAUDE_STDOUT_MAX_BUFFER_BYTES";
const DEFAULT_MAX_BUFFER_BYTES: usize = 10 * 1024 * 1024;
static MAX_BUFFER_BYTES: OnceLock<usize> = OnceLock::new();

pub(super) fn max_buffer_bytes() -> usize {
    *MAX_BUFFER_BYTES.get_or_init(|| {
        let value = std::env::var_os(MAX_BUFFER_BYTES_ENV);
        match parse_buffer_bytes(value.as_deref()) {
            Some(limit) => limit,
            None => {
                log_executor_event(
                    "invalid claude stdout buffer limit; using default",
                    &[
                        ("level", "warning".to_owned()),
                        ("environment_variable", MAX_BUFFER_BYTES_ENV.to_owned()),
                        ("default_bytes", DEFAULT_MAX_BUFFER_BYTES.to_string()),
                        (
                            "maximum_bytes",
                            CLAUDE_STDOUT_MAX_RAW_MESSAGE_BYTES.to_string(),
                        ),
                    ],
                );
                DEFAULT_MAX_BUFFER_BYTES
            }
        }
    })
}

fn parse_buffer_bytes(value: Option<&OsStr>) -> Option<usize> {
    let Some(value) = value else {
        return Some(DEFAULT_MAX_BUFFER_BYTES);
    };
    value
        .to_str()?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|limit| (1..=CLAUDE_STDOUT_MAX_RAW_MESSAGE_BYTES).contains(limit))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_buffer_bytes, CLAUDE_STDOUT_MAX_RAW_MESSAGE_BYTES, DEFAULT_MAX_BUFFER_BYTES,
    };
    use std::ffi::OsStr;

    #[test]
    fn accepts_positive_limits_and_surrounding_whitespace() {
        for (value, expected) in [
            ("1", 1),
            ("67108864", CLAUDE_STDOUT_MAX_RAW_MESSAGE_BYTES),
            ("20971520", 20 * 1024 * 1024),
            (" \t10485760\n", DEFAULT_MAX_BUFFER_BYTES),
        ] {
            assert_eq!(
                parse_buffer_bytes(Some(OsStr::new(value))),
                Some(expected),
                "{value:?}",
            );
        }
    }

    #[test]
    fn rejects_blank_invalid_overflowing_and_out_of_range_values() {
        for value in [
            "",
            " \t\n",
            "0",
            "-1",
            "invalid",
            "1.5",
            "10MiB",
            "67108865",
            "99999999999999999999999999999999999999",
        ] {
            assert_eq!(
                parse_buffer_bytes(Some(OsStr::new(value))),
                None,
                "{value:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_unicode_values() {
        use std::os::unix::ffi::OsStrExt;

        assert_eq!(parse_buffer_bytes(Some(OsStr::from_bytes(&[0xff]))), None);
    }
}
