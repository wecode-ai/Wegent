// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `calculate_next_execution_time` (`app.services.subscription.helpers`).
//!
//! The source uses `croniter` with `ZoneInfo` for cron triggers and pure
//! arithmetic for interval/one-time triggers. Every result is a naive UTC
//! datetime for storage.

use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use std::str::FromStr;

/// Compute the next execution time for a trigger type and config, mirroring the
/// source's per-type branches. `now_utc` is the naive UTC "now".
pub(crate) fn calculate_next_execution_time(
    trigger_type: &str,
    config: &Value,
    now_utc: NaiveDateTime,
) -> Option<NaiveDateTime> {
    match trigger_type {
        "cron" => {
            let expression = config
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or("0 9 * * *");
            let timezone = config
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC");
            next_cron_utc(expression, timezone, now_utc)
        }
        "interval" => {
            let value = config.get("value").and_then(Value::as_i64).unwrap_or(1);
            let unit = config
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("hours");
            match unit {
                "minutes" => Some(now_utc + chrono::Duration::minutes(value)),
                "hours" => Some(now_utc + chrono::Duration::hours(value)),
                "days" => Some(now_utc + chrono::Duration::days(value)),
                _ => None,
            }
        }
        "one_time" => {
            let execute_at = config.get("execute_at")?;
            let raw = execute_at.as_str()?;
            one_time_utc(raw, config.get("timezone").and_then(Value::as_str))
        }
        _ => None,
    }
}

/// `croniter(expr, now_local).get_next()` converted back to naive UTC.
fn next_cron_utc(
    expression: &str,
    timezone: &str,
    now_utc: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let tz: Tz = Tz::from_str(timezone).unwrap_or(chrono_tz::UTC);
    let now_local = Utc
        .from_utc_datetime(&now_utc)
        .with_timezone(&tz)
        .naive_local();
    let schedule = CronSchedule::parse(expression)?;
    let next_local = schedule.next_after(now_local)?;
    let next_utc = tz
        .from_local_datetime(&next_local)
        .single()
        .or_else(|| tz.from_local_datetime(&next_local).earliest())?
        .with_timezone(&Utc)
        .naive_utc();
    Some(next_utc)
}

/// `one_time`: ISO-8601 `execute_at`, honoring `Z` and an optional config
/// timezone for naive values.
fn one_time_utc(raw: &str, timezone: Option<&str>) -> Option<NaiveDateTime> {
    let normalized = raw.replace('Z', "+00:00");
    if let Ok(aware) = chrono::DateTime::parse_from_rfc3339(&normalized) {
        return Some(aware.with_timezone(&Utc).naive_utc());
    }
    let naive = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f"))
        .ok()?;
    if let Some(timezone) = timezone
        && let Ok(tz) = Tz::from_str(timezone)
        && let Some(aware) = tz.from_local_datetime(&naive).single()
    {
        return Some(aware.with_timezone(&Utc).naive_utc());
    }
    Some(naive)
}

/// A parsed five-field cron expression.
struct CronSchedule {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Field,
    months: Vec<u32>,
    weekdays: Field,
}

/// A day-of-month/day-of-week field with its restriction flag (for the
/// standard "either matches" rule when both are restricted).
struct Field {
    values: Vec<u32>,
    restricted: bool,
}

impl CronSchedule {
    /// Parse the standard five-field form; an unknown form yields `None`, which
    /// the source renders as "no next execution" after its parse failure.
    fn parse(expression: &str) -> Option<Self> {
        let parts: Vec<&str> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return None;
        }
        Some(Self {
            minutes: parse_field(parts[0], 0, 59)?,
            hours: parse_field(parts[1], 0, 23)?,
            days: Field::parse(parts[2], 1, 31)?,
            months: parse_field(parts[3], 1, 12)?,
            weekdays: Field::parse(parts[4], 0, 7)?,
        })
    }

    /// The first matching local minute strictly after `after`.
    fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let start = after.with_second(0)?.with_nanosecond(0)? + chrono::Duration::minutes(1);
        let mut date = start.date();
        // Bounded search: five years is far beyond any real schedule's next run.
        for _ in 0..(366 * 5) {
            if self.month_matches(date)
                && self.day_matches(date)
                && let Some(candidate) = self.first_time_on(date, start)
            {
                return Some(candidate);
            }
            date = date.succ_opt()?;
        }
        None
    }

    fn month_matches(&self, date: NaiveDate) -> bool {
        self.months.contains(&date.month())
    }

    /// Standard cron day rule: when both day-of-month and day-of-week are
    /// restricted, a day matches if either does; otherwise only the restricted
    /// one applies.
    fn day_matches(&self, date: NaiveDate) -> bool {
        let dom = self.days.values.contains(&date.day());
        // croniter maps Sunday to both 0 and 7.
        let weekday = date.weekday().num_days_from_sunday();
        let dow = self.weekdays.values.contains(&weekday)
            || self.weekdays.values.contains(&7) && weekday == 0;
        match (self.days.restricted, self.weekdays.restricted) {
            (true, true) => dom || dow,
            (true, false) => dom,
            (false, true) => dow,
            (false, false) => true,
        }
    }

    fn first_time_on(&self, date: NaiveDate, start: NaiveDateTime) -> Option<NaiveDateTime> {
        for hour in &self.hours {
            for minute in &self.minutes {
                let candidate = date.and_hms_opt(*hour, *minute, 0)?;
                if candidate >= start {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

impl Field {
    fn parse(part: &str, min: u32, max: u32) -> Option<Self> {
        Some(Self {
            values: parse_field(part, min, max)?,
            restricted: part != "*",
        })
    }
}

/// Parse one cron field into its sorted value set.
fn parse_field(part: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut values = Vec::new();
    for item in part.split(',') {
        let (range_part, step) = match item.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().ok()?),
            None => (item, 1),
        };
        let step = if step == 0 { 1 } else { step };
        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            (parse_value(a, min, max)?, parse_value(b, min, max)?)
        } else {
            let value = parse_value(range_part, min, max)?;
            (value, value)
        };
        if start > end {
            return None;
        }
        let mut value = start;
        while value <= end {
            if (value - start) % step == 0 {
                values.push(value);
            }
            value += 1;
        }
    }
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    values.dedup();
    Some(values)
}

fn parse_value(token: &str, min: u32, max: u32) -> Option<u32> {
    let value: u32 = token.parse().ok()?;
    if value < min || value > max {
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn utc(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap()
    }

    #[test]
    fn cron_in_asia_shanghai_matches_the_recorded_weekday() {
        // 2026-10-07 is a Wednesday; the next Friday 20:15 CST is 12:15 UTC.
        let next = calculate_next_execution_time(
            "cron",
            &json!({"expression": "15 20 * * 5", "timezone": "Asia/Shanghai"}),
            utc("2026-10-07T07:05:27"),
        );
        assert_eq!(next, Some(utc("2026-10-09T12:15:00")));
    }

    #[test]
    fn cron_utc_uses_the_expression_directly() {
        let next = calculate_next_execution_time(
            "cron",
            &json!({"expression": "0 9 * * *", "timezone": "UTC"}),
            utc("2026-10-07T10:00:00"),
        );
        assert_eq!(next, Some(utc("2026-10-08T09:00:00")));
    }

    #[test]
    fn interval_adds_from_utc_now() {
        assert_eq!(
            calculate_next_execution_time(
                "interval",
                &json!({"value": 2, "unit": "hours"}),
                utc("2026-10-07T07:05:27")
            ),
            Some(utc("2026-10-07T09:05:27"))
        );
    }

    #[test]
    fn event_triggers_have_no_next_time() {
        assert_eq!(
            calculate_next_execution_time(
                "event",
                &json!({"event_type": "webhook"}),
                utc("2026-10-07T07:05:27")
            ),
            None
        );
    }

    #[test]
    fn invalid_expression_yields_none() {
        assert_eq!(
            next_cron_utc("not a cron", "UTC", utc("2026-10-07T07:05:27")),
            None
        );
    }
}
