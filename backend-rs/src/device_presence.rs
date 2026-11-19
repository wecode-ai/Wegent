// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persistent device presence is independent of the expiring online cache.

use chrono::{DateTime, Local, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{Value, json};

pub(crate) fn mark_registered(document: &mut Value, observed_at: DateTime<Utc>) {
    let status = &mut document["status"];
    if !status.is_object() {
        *status = json!({});
    }
    let previous = status["lastSeenAt"]
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
    if previous.is_none_or(|previous| previous < observed_at) {
        status["lastSeenAt"] = json!(observed_at.to_rfc3339_opts(SecondsFormat::Micros, false));
    }
}

pub(crate) fn latest_online_time(stored: Option<&str>, observed: Option<&str>) -> Option<String> {
    [stored, observed]
        .into_iter()
        .flatten()
        .filter_map(parse_observed_time)
        .max()
        .map(|at| at.with_timezone(&chrono::Utc).to_rfc3339())
}

pub(crate) fn parse_observed_time(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value.with_timezone(&Utc));
    }
    let local = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_preserves_status_fields_and_never_regresses_presence() {
        let mut document = json!({"status": {"state":"Available"}});
        let observed = "2026-11-09T09:00:00.123456Z".parse().unwrap();
        mark_registered(&mut document, observed);
        mark_registered(&mut document, observed - chrono::TimeDelta::seconds(1));
        assert_eq!(
            document["status"],
            json!({
                "state": "Available", "lastSeenAt": "2026-11-09T09:00:00.123456+00:00"
            })
        );
    }

    #[test]
    fn online_time_accepts_the_socket_cache_wall_clock_format() {
        let local = Local
            .with_ymd_and_hms(2026, 11, 9, 9, 0, 0)
            .single()
            .unwrap();
        assert_eq!(
            parse_observed_time("2026-11-09T09:00:00.000000"),
            Some(local.with_timezone(&Utc))
        );
    }
}
