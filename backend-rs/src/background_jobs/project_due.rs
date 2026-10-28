// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Scheduled automation claims advance the rule and insert its run atomically.

use super::{
    dispatch,
    store::{self, COLUMNS, LIVE, Node, iso},
};
use crate::state::AppState;
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::json;

#[derive(FromMysqlRow)]
struct Id {
    id: String,
}

fn next_at(rule: &Node, now: NaiveDateTime) -> Result<NaiveDateTime> {
    let expression = rule.metadata.0["cron_expression"].as_str().unwrap_or("");
    let timezone = rule.metadata.0["timezone"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("Asia/Shanghai");
    next_occurrence(expression, timezone, now)
}

fn next_occurrence(expression: &str, timezone: &str, now: NaiveDateTime) -> Result<NaiveDateTime> {
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
    let next = trigger
        .next_after(now.and_utc().timestamp_millis())
        .map_err(|_| anyhow::anyhow!("Invalid cron expression"))?
        .ok_or_else(|| anyhow::anyhow!("Invalid cron expression"))?;
    Ok(chrono::DateTime::from_timestamp_millis(next)
        .ok_or_else(|| anyhow::anyhow!("Cron occurrence is out of range"))?
        .naive_utc())
}

pub(super) async fn check(state: &AppState) -> Result<usize> {
    let now = Utc::now().naive_utc();
    let ids:Vec<Id>=state.mysql.fetch_all("SELECT rule.id FROM loop_items rule JOIN loop_items project ON project.id=rule.cloud_project_id AND project.resource_type='project' WHERE rule.resource_type='automation_rule' AND project.status='active' AND rule.status='enabled' AND rule.due_at>'1970-01-02' AND rule.due_at<=? AND (rule.deleted_at IS NULL OR rule.deleted_at<='1970-01-02')",(now,)).await?;
    let mut count = 0;
    for id in ids {
        let claimed=state.mysql.with_transaction(async |tx| {
            let rule:Option<Node>=tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='automation_rule' AND status='enabled' AND due_at>'1970-01-02' AND due_at<=? AND {LIVE} FOR UPDATE SKIP LOCKED"),(id.id.as_str(),now)).await?;
            let Some(rule)=rule else{return Ok(None)};
            if rule.metadata.0["trigger_type"]!="schedule"{return Ok(None)}
            let scheduled_for=rule.due_at.expect("due candidate");
            let next=match next_at(&rule,now.max(scheduled_for)) {
                Ok(next)=>next,
                Err(error)=>{
                    let mut metadata=rule.meta();metadata["schedule_error"]=json!(error.to_string());
                    tx.execute("UPDATE loop_items SET status='disabled',metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),rule.id.as_str())).await?;
                    tracing::error!(rule_id=%rule.id,%error,"disabled invalid project automation schedule");
                    return Ok(None)
                }
            };
            let run_id=store::insert(tx,"automation_run",store::new_run(&rule,"scheduled",scheduled_for,None)).await?;
            let mut metadata=rule.meta();metadata["last_run_at"]=json!(iso(scheduled_for));metadata.as_object_mut().unwrap().remove("schedule_error");
            tx.execute("UPDATE loop_items SET due_at=?,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(next,Json(metadata),rule.id.as_str())).await?;
            Ok(Some((rule,run_id)))
        }).await?;
        if let Some((rule, run_id)) = claimed {
            let run = store::get(&state.mysql, "automation_run", &run_id)
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
            next_occurrence("0 9 * * *", "Asia/Shanghai", at("2026-10-23 00:00:00")).unwrap(),
            at("2026-10-23 01:00:00")
        );
        assert_eq!(
            next_occurrence("0 9 1 * 1", "UTC", at("2026-10-23 00:00:00")).unwrap(),
            at("2026-10-26 09:00:00")
        );
        assert_eq!(
            next_occurrence("* * * * * 30", "UTC", at("2026-10-23 00:00:00")).unwrap(),
            at("2026-10-23 00:00:30")
        );
        assert_eq!(
            next_occurrence("0 0 1 1 * 0 2027", "UTC", at("2026-10-23 00:00:00")).unwrap(),
            at("2027-01-01 00:00:00")
        );
    }
    #[test]
    fn invalid_schedule_or_timezone_is_rejected() {
        assert!(next_occurrence("invalid", "UTC", at("2026-10-23 00:00:00")).is_err());
        assert!(next_occurrence("* * * * *", "No/Such_Zone", at("2026-10-23 00:00:00")).is_err());
    }
}
