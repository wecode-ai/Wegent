use super::*;
use std::collections::BTreeMap;

fn percentile(values: &mut [f64], fraction: f64) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return None;
    }
    let index = (values.len() - 1) as f64 * fraction;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    Some(values[lower] + (values[upper] - values[lower]) * (index - lower as f64))
}

pub(super) fn units(facts: &[Evidence], window: Window, person: Option<i32>) -> Value {
    let mut selected = BTreeMap::new();
    for evidence in facts {
        let Fact::Unit {
            unit_id,
            content_version,
            accepted_version,
            accepted_at,
            classification,
            contributors,
        } = &evidence.fact
        else {
            continue;
        };
        if accepted_version.as_ref() != Some(content_version)
            || !accepted_at.is_some_and(|at| window.contains(at))
            || person.is_some_and(|id| !contributors.contains(&id))
        {
            continue;
        }
        selected.insert(
            (evidence.issue_id.as_str(), unit_id.as_str()),
            (evidence, classification),
        );
    }
    let mut counts = BTreeMap::from([("ai", 0), ("mixed", 0), ("human", 0), ("unknown", 0)]);
    let mut rows = Vec::new();
    for (evidence, mode) in selected.values() {
        let key = match mode {
            Classification::Ai => "ai",
            Classification::Mixed => "mixed",
            Classification::Human => "human",
            Classification::Unknown => "unknown",
        };
        *counts.get_mut(key).unwrap() += 1;
        rows.push(json!({"key":evidence.key,"issue_id":evidence.issue_id,"fact":evidence.fact}));
    }
    let total = selected.len();
    json!({"counts":counts,"numerator":counts["ai"],"denominator":total,"sample":total,
        "ai_independent_share":(total>0 && counts["unknown"]==0).then(||counts["ai"] as f64/total as f64),
        "units":rows})
}

pub(super) fn cycles(
    issues: &[super::super::Issue],
    facts: &[Evidence],
    members: &BTreeSet<i32>,
    window: Window,
    person: Option<i32>,
) -> Value {
    let completion = super::completion::compute(issues, facts, members, window, person);
    let selected: BTreeSet<_> = completion["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["issue_id"].as_str())
        .collect();
    let mut durations = Vec::new();
    let mut rows = Vec::new();
    for issue in issues
        .iter()
        .filter(|issue| selected.contains(issue.id.as_str()))
    {
        let start = super::super::issue_start(issue).and_utc();
        let end = super::super::completion_time(issue).unwrap().and_utc();
        if end < start {
            continue;
        }
        let elapsed = seconds(start, end);
        durations.push(elapsed);
        rows.push(json!({"issue_id":issue.id,"start":start,"end":end,"seconds":elapsed}));
    }
    json!({"p50_seconds":percentile(&mut durations,0.5),"p90_seconds":percentile(&mut durations,0.9),"sample":rows.len(),"issues":rows})
}

pub(super) fn handoffs(facts: &[Evidence], window: Window, person: Option<i32>) -> Value {
    let mut queues = Vec::new();
    let mut started = Vec::new();
    let mut pending = Vec::new();
    let mut longest: f64 = 0.0;
    for evidence in facts {
        let Fact::Handoff {
            ready_at,
            started_at,
            wait_type,
            owner_user_id,
        } = &evidence.fact
        else {
            continue;
        };
        if *ready_at >= window.as_of || person.is_some_and(|id| *owner_user_id != Some(id)) {
            continue;
        }
        match started_at.filter(|at| *at < window.as_of) {
            Some(at) if window.contains(at) && at >= *ready_at => {
                let elapsed = seconds(*ready_at, at);
                if *wait_type == WaitType::Queue {
                    queues.push(elapsed);
                }
                started.push(
                    json!({"key":evidence.key,"issue_id":evidence.issue_id,"ready_at":ready_at,
                    "started_at":at,"seconds":elapsed,"wait_type":wait_type}),
                );
            }
            None => {
                let elapsed = seconds(*ready_at, window.as_of);
                longest = longest.max(elapsed);
                pending.push(
                    json!({"key":evidence.key,"issue_id":evidence.issue_id,"ready_at":ready_at,
                    "waiting_seconds":elapsed,"wait_type":wait_type}),
                );
            }
            _ => {}
        }
    }
    json!({"queue_p50_seconds":percentile(&mut queues,0.5),"sample":queues.len(),"started":started,
        "backlog":pending.len(),"longest_wait_seconds":longest,"pending":pending})
}
