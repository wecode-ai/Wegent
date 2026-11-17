// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Offline mainland China statutory calendar shared with Python consumers.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Calendar {
    start_date: String,
    end_date: String,
    holidays: Vec<String>,
    workdays: Vec<String>,
}

fn calendar() -> Result<&'static Calendar, String> {
    static CALENDAR: OnceLock<Result<Calendar, String>> = OnceLock::new();
    CALENDAR
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../assets/calendars/china-workdays.json"
            ))
            .map_err(|error| format!("Invalid China statutory workday calendar: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Classify a validated ISO date and its weekday (Monday=0, Sunday=6).
pub fn is_china_workday(date: &str, weekday: u32) -> Result<bool, String> {
    let calendar = calendar()?;
    if weekday > 6 {
        return Err("Invalid weekday for China statutory workday calendar".into());
    }
    if date < calendar.start_date.as_str() || date > calendar.end_date.as_str() {
        return Err(format!(
            "China statutory workday calendar does not cover {date}"
        ));
    }
    if calendar
        .workdays
        .binary_search_by(|day| day.as_str().cmp(date))
        .is_ok()
    {
        return Ok(true);
    }
    Ok(weekday < 5
        && calendar
            .holidays
            .binary_search_by(|day| day.as_str().cmp(date))
            .is_err())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holidays_makeup_days_and_ordinary_weekends() {
        assert!(!is_china_workday("2026-10-01", 3).unwrap());
        assert!(is_china_workday("2026-10-10", 5).unwrap());
        assert!(!is_china_workday("2026-11-15", 6).unwrap());
        assert!(is_china_workday("2026-11-16", 0).unwrap());
    }

    #[test]
    fn calendar_coverage_is_explicit() {
        assert!(is_china_workday("2004-01-01", 3).is_ok());
        assert!(is_china_workday("2027-12-31", 4).is_ok());
        assert!(is_china_workday("2003-12-31", 2).is_err());
        assert!(is_china_workday("2028-01-01", 5).is_err());
        assert!(is_china_workday("2026-11-16", 7).is_err());
    }
}
