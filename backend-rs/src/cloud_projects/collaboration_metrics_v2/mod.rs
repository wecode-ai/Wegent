//! Versioned, independently sampled collaboration facts. Never inspect transcripts.
mod activity;
mod capacity;
mod completion;
mod deliveries;
mod outcomes;
pub(super) mod repository;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Evidence {
    pub key: String,
    pub revision: u64,
    pub issue_id: String,
    pub references: Vec<String>,
    pub fact: Fact,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Fact {
    Contribution {
        user_id: Option<i32>,
        basis: ContributionBasis,
        effective_at: DateTime<Utc>,
        revoked: bool,
    },
    Activity {
        agent_id: String,
        run_id: String,
        owner_user_id: Option<i32>,
        started_at: DateTime<Utc>,
        ended_at: Option<DateTime<Utc>>,
        state: ActivityState,
        outcome: RunOutcome,
    },
    Unit {
        unit_id: String,
        content_version: String,
        accepted_version: Option<String>,
        accepted_at: Option<DateTime<Utc>>,
        classification: Classification,
        contributors: BTreeSet<i32>,
    },
    Handoff {
        ready_at: DateTime<Utc>,
        started_at: Option<DateTime<Utc>>,
        wait_type: WaitType,
        owner_user_id: Option<i32>,
    },
    Capacity {
        user_id: i32,
        calendar_id: String,
        available_seconds: f64,
        member_from: DateTime<Utc>,
        member_until: DateTime<Utc>,
    },
}

impl Evidence {
    pub(in crate::cloud_projects::collaboration_metrics) fn attributed_to(
        &self,
        user: i32,
    ) -> bool {
        match &self.fact {
            Fact::Contribution { user_id, .. } => *user_id == Some(user),
            Fact::Activity { owner_user_id, .. } | Fact::Handoff { owner_user_id, .. } => {
                *owner_user_id == Some(user)
            }
            Fact::Unit { contributors, .. } => contributors.contains(&user),
            Fact::Capacity { user_id, .. } => *user_id == user,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ContributionBasis {
    Delivery,
    CompletedStage,
    FormalReview,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ActivityState {
    Active,
    Queue,
    Approval,
    Offline,
    ChildWait,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RunOutcome {
    Running,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Classification {
    Ai,
    Mixed,
    Human,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum WaitType {
    Queue,
    Judgment,
    External,
}

#[derive(Clone, Copy)]
pub(super) struct Window {
    pub as_of: DateTime<Utc>,
}
impl Window {
    pub fn start(self) -> DateTime<Utc> {
        self.as_of - Duration::days(7)
    }
    pub fn contains(self, at: DateTime<Utc>) -> bool {
        at >= self.start() && at < self.as_of
    }
    pub fn clip(
        self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let range = (start.max(self.start()), end.min(self.as_of));
        (range.1 > range.0).then_some(range)
    }
    pub fn view(self) -> Value {
        json!({"start":self.start(),"end":self.as_of,"days":7})
    }
}

pub(super) fn aggregate(
    issues: &[super::Issue],
    facts: &[Evidence],
    members: &BTreeSet<i32>,
    window: Window,
    person: Option<i32>,
) -> Value {
    json!({
        "definition_version":"collab-v2", "as_of":window.as_of,"window":window.view(),
        "denominator_definition":"current_effective_members_participation",
        "member_snapshot":members,
        "completion":completion::compute(issues,facts,members,window,person),
        "activity":activity::compute(facts,members,window,person),
        "delivery":outcomes::units(facts,window,person),
        "cycle":outcomes::cycles(issues,facts,members,window,person),
        "handoff":outcomes::handoffs(facts,window,person),
        "evidence":facts.iter().filter(|fact|person.is_none_or(|id|fact.attributed_to(id))).collect::<Vec<_>>(),
    })
}

pub(super) fn mark_unavailable(response: &mut Value, missing: &[Evidence], person: Option<i32>) {
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for record in missing
        .iter()
        .filter(|record| person.is_none_or(|id| record.attributed_to(id)))
    {
        let kind = match record.fact {
            Fact::Contribution { .. } => "contribution",
            Fact::Unit { .. } => "unit",
            Fact::Activity { .. } => "activity",
            Fact::Capacity { .. } => "capacity",
            Fact::Handoff { .. } => "handoff",
        };
        *counts.entry(kind).or_default() += 1;
    }
    response["unavailable_evidence"] = json!(counts);
    if counts.contains_key("contribution") || counts.contains_key("unit") {
        response["completion"]["unknown_evidence"] = json!(
            counts.get("contribution").copied().unwrap_or(0)
                + counts.get("unit").copied().unwrap_or(0)
        );
    }
    if counts.contains_key("unit") {
        response["delivery"]["ai_independent_share"] = Value::Null;
    }
    if counts.contains_key("activity") || counts.contains_key("capacity") {
        response["activity"]["partial"] = json!(true);
        response["activity"]["runtime_to_capacity_ratio"] = Value::Null;
    }
    if counts.contains_key("handoff") {
        response["handoff"]["partial"] = json!(true);
    }
}

pub(super) fn seconds(start: DateTime<Utc>, end: DateTime<Utc>) -> f64 {
    (end - start).num_milliseconds() as f64 / 1000.0
}

#[cfg(test)]
mod tests;
