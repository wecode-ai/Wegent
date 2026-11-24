// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Scheduled automation claims advance the rule and insert its run atomically.

use super::store::{self, COLUMNS, LIVE, Node, iso};
use super::{Scheduler, dispatch};
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::{Datelike, NaiveDateTime, TimeZone, Utc};
use serde_json::{Value, json};

#[derive(FromMysqlRow)]
struct Id {
    id: String,
}

#[derive(Debug)]
struct WorkdayCalendarUnavailable(String);

impl std::fmt::Display for WorkdayCalendarUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for WorkdayCalendarUnavailable {}

fn next_at(rule: &Node, now: NaiveDateTime) -> Result<NaiveDateTime> {
    let expression = rule.metadata.0["cron_expression"].as_str().unwrap_or("");
    let timezone = rule.metadata.0["timezone"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("Asia/Shanghai");
    next_occurrence(expression, timezone, now, workday_only(&rule.metadata.0)?)
}

fn workday_only(metadata: &Value) -> Result<bool> {
    match metadata.get("workday_only") {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => anyhow::bail!("workday_only must be a boolean"),
    }
}

pub fn permits_scheduled_run(metadata: &Value, trigger: &str, now: NaiveDateTime) -> Result<bool> {
    if trigger != "scheduled" || !workday_only(metadata)? {
        return Ok(true);
    }
    let china_date = now.and_utc().with_timezone(&chrono_tz::Asia::Shanghai);
    wegent_protocol::workday_calendar::is_china_workday(
        &china_date.format("%Y-%m-%d").to_string(),
        china_date.weekday().num_days_from_monday(),
    )
    .map_err(|error| anyhow::Error::new(WorkdayCalendarUnavailable(error)))
}

fn next_occurrence(
    expression: &str,
    timezone: &str,
    now: NaiveDateTime,
    workday_only: bool,
) -> Result<NaiveDateTime> {
    // croniter places optional seconds after weekday; croner places them first.
    let fields: Vec<_> = expression.split_whitespace().collect();
    let expression = match fields.len() {
        6 => format!("{} {}", fields[5], fields[..5].join(" ")),
        7 => format!("{} {} {}", fields[5], fields[..5].join(" "), fields[6]),
        _ => expression.to_owned(),
    };
    let _: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("Unknown timezone"))?;
    let trigger = brz_schedule::Trigger::Cron {
        expression,
        timezone: timezone.into(),
        day_match: brz_schedule::DayMatch::Or,
    };
    let mut reference = now.and_utc().timestamp_millis();
    loop {
        let next = trigger
            .next_after(reference)
            .map_err(|_| anyhow::anyhow!("Invalid cron expression"))?
            .and_then(chrono::DateTime::from_timestamp_millis)
            .ok_or_else(|| anyhow::anyhow!("Cron occurrence is out of range"))?;
        if !workday_only
            || permits_scheduled_run(
                &json!({"workday_only": true}),
                "scheduled",
                next.naive_utc(),
            )?
        {
            return Ok(next.naive_utc());
        }
        let next_day = next
            .with_timezone(&chrono_tz::Asia::Shanghai)
            .date_naive()
            .succ_opt()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .and_then(|date| {
                chrono_tz::Asia::Shanghai
                    .from_local_datetime(&date)
                    .single()
            })
            .ok_or_else(|| anyhow::anyhow!("Cron occurrence is out of range"))?;
        reference = next_day.timestamp_millis() - 1;
    }
}

pub async fn check(state: &Scheduler<'_>) -> Result<usize> {
    let now = Utc::now().naive_utc();
    let ids:Vec<Id>=state.mysql.fetch_all("SELECT rule.id FROM loop_items rule JOIN loop_items project ON project.id=rule.cloud_project_id AND project.resource_type='project' WHERE rule.resource_type='automation_rule' AND project.status='active' AND rule.status='enabled' AND rule.due_at>'1970-01-02' AND rule.due_at<=? AND (rule.deleted_at IS NULL OR rule.deleted_at<='1970-01-02')",(now,)).await?;
    let mut count = 0;
    for id in ids {
        let claimed=state.mysql.with_transaction(async |tx| {
            let rule:Option<Node>=tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='automation_rule' AND status='enabled' AND due_at>'1970-01-02' AND due_at<=? AND {LIVE} FOR UPDATE SKIP LOCKED"),(id.id.as_str(),now)).await?;
            let Some(rule)=rule else{return Ok(None)};
            if rule.metadata.0["trigger_type"]!="schedule"{return Ok(None)}
            let scheduled_for=rule.due_at.expect("due candidate");
            let (next,can_dispatch)=match next_at(&rule,now.max(scheduled_for)).and_then(|next| permits_scheduled_run(&rule.metadata.0,"scheduled",now).map(|allowed|(next,allowed))) {
                Ok(next)=>next,
                Err(error)=>{
                    let mut metadata=rule.meta();metadata["schedule_error"]=json!(error.to_string());
                    let status=if error.is::<WorkdayCalendarUnavailable>(){"enabled"}else{"disabled"};
                    tx.execute("UPDATE loop_items SET status=?,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(status,Json(metadata),rule.id.as_str())).await?;
                    tracing::error!(rule_id=%rule.id,%error,"project automation schedule unavailable");
                    return Ok(None)
                }
            };
            let mut metadata=rule.meta();
            let run_id=if can_dispatch {
                let id=store::insert(tx,"automation_run",store::new_run(&rule,"scheduled",scheduled_for,None)).await?;
                metadata["last_run_at"]=json!(iso(scheduled_for));Some(id)
            }else{None};
            metadata.as_object_mut().unwrap().remove("schedule_error");
            tx.execute("UPDATE loop_items SET due_at=?,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(next,Json(metadata),rule.id.as_str())).await?;
            Ok(run_id.map(|run_id|(rule,run_id)))
        }).await?;
        if let Some((rule, run_id)) = claimed {
            let run = store::get(state.mysql, "automation_run", &run_id)
                .await?
                .expect("committed automation run");
            dispatch::run(state, &rule, &run).await?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    #[test]
    fn scheduled_rules_preserve_croniter_timezone_or_and_seconds_position() {
        assert_eq!(
            next_occurrence(
                "0 9 * * *",
                "Asia/Shanghai",
                at("2026-10-23 00:00:00"),
                false
            )
            .unwrap(),
            at("2026-10-23 01:00:00")
        );
        assert_eq!(
            next_occurrence("0 9 1 * 1", "UTC", at("2026-10-23 00:00:00"), false).unwrap(),
            at("2026-10-26 09:00:00")
        );
        assert_eq!(
            next_occurrence("* * * * * 30", "UTC", at("2026-10-23 00:00:00"), false).unwrap(),
            at("2026-10-23 00:00:30")
        );
        assert_eq!(
            next_occurrence("0 0 1 1 * 0 2027", "UTC", at("2026-10-23 00:00:00"), false).unwrap(),
            at("2027-01-01 00:00:00")
        );
    }
    #[test]
    fn invalid_schedule_or_timezone_is_rejected() {
        assert!(next_occurrence("invalid", "UTC", at("2026-10-23 00:00:00"), false).is_err());
        assert!(
            next_occurrence(
                "* * * * *",
                "No/Such_Zone",
                at("2026-10-23 00:00:00"),
                false
            )
            .is_err()
        );
    }

    #[test]
    fn workday_schedules_skip_holidays_and_include_makeup_weekends() {
        for (now, expected) in [
            ("2026-09-30 02:00:00", "2026-10-08 01:00:00"),
            ("2026-10-09 02:00:00", "2026-10-10 01:00:00"),
            ("2026-10-10 02:00:00", "2026-10-12 01:00:00"),
        ] {
            assert_eq!(
                next_occurrence("0 9 * * *", "Asia/Shanghai", at(now), true).unwrap(),
                at(expected)
            );
        }
        assert_eq!(
            next_occurrence("0 17 * * *", "UTC", at("2026-09-30 15:00:00"), true).unwrap(),
            at("2026-10-07 17:00:00")
        );
        assert!(next_occurrence("0 9 * * *", "UTC", at("2100-01-01 00:00:00"), true).is_err());
    }

    #[test]
    fn dispatch_uses_actual_china_day_and_preserves_manual_runs() {
        let filtered = json!({"workday_only": true});
        assert!(!permits_scheduled_run(&filtered, "scheduled", at("2026-09-30 17:00:00")).unwrap());
        assert!(permits_scheduled_run(&filtered, "scheduled", at("2026-10-10 01:00:00")).unwrap());
        assert!(permits_scheduled_run(&filtered, "manual", at("2100-01-01 00:00:00")).unwrap());
        assert!(permits_scheduled_run(&json!({}), "scheduled", at("2100-01-01 00:00:00")).unwrap());
        let error =
            permits_scheduled_run(&filtered, "scheduled", at("2100-01-01 00:00:00")).unwrap_err();
        assert!(error.is::<WorkdayCalendarUnavailable>());
    }
}
