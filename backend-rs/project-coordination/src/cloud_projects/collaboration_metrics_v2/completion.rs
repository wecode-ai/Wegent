use super::*;
use std::collections::BTreeMap;

pub(super) fn compute(
    issues: &[super::super::Issue],
    facts: &[Evidence],
    members: &BTreeSet<i32>,
    window: Window,
    person: Option<i32>,
) -> Value {
    let mut people = BTreeMap::<String, usize>::new();
    let mut rows = Vec::new();
    let mut unknown = 0;
    let mut member_participations = 0;
    for issue in issues
        .iter()
        .filter(|issue| super::super::completed_in_window(issue, window.as_of.naive_utc()))
    {
        let ended = super::super::completion_time(issue).unwrap().and_utc();
        let mut participants = BTreeSet::new();
        let mut references = Vec::new();
        let mut issue_unknown = 0;
        for evidence in facts.iter().filter(|fact| fact.issue_id == issue.id) {
            match &evidence.fact {
                Fact::Contribution {
                    user_id,
                    effective_at,
                    revoked: false,
                    ..
                } if *effective_at <= ended => {
                    if let Some(id) = user_id.filter(|id| *id > 0) {
                        participants.insert(id);
                    } else {
                        issue_unknown += 1;
                    }
                    references.push(evidence.key.clone());
                }
                Fact::Unit {
                    accepted_at: Some(at),
                    content_version,
                    accepted_version: Some(version),
                    contributors,
                    ..
                } if *at <= ended && content_version == version => {
                    participants.extend(contributors.iter().filter(|id| **id > 0));
                    references.push(evidence.key.clone());
                }
                _ => {}
            }
        }
        // An explicit manual completion is a completed stage, not an assignee guess.
        if let Some(event) = super::super::completion_event(issue)
            && event["trigger"] == "user_update"
            && event.get("automation").is_none()
            && let Some(id) = event["by_user_id"]
                .as_i64()
                .and_then(|id| i32::try_from(id).ok())
                .filter(|id| *id > 0)
        {
            participants.insert(id);
        }
        if participants.is_empty() && issue_unknown == 0 {
            issue_unknown += 1;
        }
        if person.is_some_and(|id| !participants.contains(&id)) {
            continue;
        }
        unknown += issue_unknown;
        for id in participants
            .iter()
            .filter(|id| person.is_none_or(|person| **id == person))
        {
            *people.entry(id.to_string()).or_default() += 1;
            member_participations += usize::from(members.contains(id));
        }
        rows.push(json!({"issue_id":issue.id,"completed_at":ended,"participants":participants,
            "references":references,"reopened":super::super::history(issue).iter().any(|event|event["from_status"]=="completed")}));
    }
    let sample = rows.len();
    let denominator = if person.is_some() { 1 } else { members.len() };
    let numerator = if person.is_some() {
        sample
    } else {
        member_participations
    };
    json!({"completed":sample,"sample":sample,"per_person":people,"unknown":unknown,
        "numerator":numerator,"denominator":denominator,
        "per_member":(denominator>0).then(||numerator as f64 / denominator as f64),"issues":rows})
}
