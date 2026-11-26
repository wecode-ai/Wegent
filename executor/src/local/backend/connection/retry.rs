// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

const AUTHENTICATION_RETRY_START: Duration = Duration::from_secs(30);
const AUTHENTICATION_RETRY_MAX: Duration = Duration::from_secs(300);
pub(in crate::local::backend) const AUTHENTICATION_RETRY_PREFIX: &str = "device authentication ";
pub(in crate::local::backend) const AUTHENTICATION_ERROR: &str =
    "device authentication failed: device token is invalid or expired; re-pair this device";
pub(in crate::local::backend) const AUTHENTICATION_RATE_LIMITED: &str =
    "device authentication rate limited: waiting for the retry cooldown";

pub(super) struct RetryBackoff {
    initial: Duration,
    maximum: Duration,
    network_delay: Duration,
    authentication_delay: Duration,
}

impl RetryBackoff {
    pub(super) fn new(initial: Duration, maximum: Duration) -> Self {
        Self {
            initial,
            maximum,
            network_delay: initial,
            authentication_delay: AUTHENTICATION_RETRY_START,
        }
    }

    pub(super) fn after_failure(&mut self, authentication: bool) -> Duration {
        let (next, maximum) = if authentication {
            (&mut self.authentication_delay, AUTHENTICATION_RETRY_MAX)
        } else {
            (&mut self.network_delay, self.maximum)
        };
        let delay = *next;
        *next = next.saturating_mul(2).min(maximum);
        delay
    }

    pub(super) fn reset(&mut self) {
        self.network_delay = self.initial;
        self.authentication_delay = AUTHENTICATION_RETRY_START;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_credentials_back_off_to_five_minutes_without_resetting_on_network_errors() {
        let mut retry = RetryBackoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let expected = [30, 60, 120, 240, 300, 300];
        for seconds in expected {
            assert_eq!(retry.after_failure(true), Duration::from_secs(seconds));
            retry.after_failure(false);
        }
        retry.reset();
        assert_eq!(retry.after_failure(true), Duration::from_secs(30));
        assert_eq!(retry.after_failure(false), Duration::from_secs(1));
    }

    #[test]
    fn transient_failure_preserves_the_configured_network_retry_limit() {
        let mut retry = RetryBackoff::new(Duration::from_secs(1), Duration::from_secs(3));
        for seconds in [1, 2, 3, 3] {
            assert_eq!(retry.after_failure(false), Duration::from_secs(seconds));
        }
        let mut retry = RetryBackoff::new(Duration::from_secs(5), Duration::from_secs(3));
        for seconds in [5, 3, 3] {
            assert_eq!(retry.after_failure(false), Duration::from_secs(seconds));
        }
        retry.reset();
        assert_eq!(retry.after_failure(false), Duration::from_secs(5));
    }
}
