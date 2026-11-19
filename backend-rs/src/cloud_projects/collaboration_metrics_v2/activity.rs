use super::*;
use std::collections::BTreeMap;

type Range = (DateTime<Utc>, DateTime<Utc>, bool);
type Runs = BTreeMap<(String, String), Vec<Range>>;

fn covered_ranges(ranges: Vec<Range>) -> Vec<Range> {
    let mut events = BTreeMap::<DateTime<Utc>, (i32, i32)>::new();
    for (start, end, active) in ranges {
        let left = events.entry(start).or_default();
        if active {
            left.0 += 1;
        } else {
            left.1 += 1;
        }
        let right = events.entry(end).or_default();
        if active {
            right.0 -= 1;
        } else {
            right.1 -= 1;
        }
    }
    let mut previous = None;
    let mut counts = (0, 0);
    let mut covered = Vec::new();
    for (at, delta) in events {
        if let Some(start) = previous
            && counts.0 > 0
            && counts.1 == 0
        {
            covered.push((start, at, true));
        }
        counts.0 += delta.0;
        counts.1 += delta.1;
        previous = Some(at);
    }
    covered
}

fn covered(runs: Runs) -> f64 {
    let active = runs.into_values().flat_map(covered_ranges).collect();
    covered_ranges(active)
        .into_iter()
        .map(|(start, end, _)| seconds(start, end))
        .fold(0.0, |total, duration| total + duration)
}

pub(super) fn compute(
    facts: &[Evidence],
    members: &BTreeSet<i32>,
    window: Window,
    person: Option<i32>,
) -> Value {
    let mut agents = BTreeMap::<String, Runs>::new();
    let mut per_person = BTreeMap::<String, BTreeMap<String, Runs>>::new();
    let mut rows = Vec::new();
    let mut partial = false;
    for evidence in facts {
        let Fact::Activity {
            agent_id,
            run_id,
            owner_user_id,
            started_at,
            ended_at,
            state,
            outcome,
        } = &evidence.fact
        else {
            continue;
        };
        if person.is_some_and(|id| *owner_user_id != Some(id)) {
            continue;
        }
        let open = ended_at.is_none();
        if open && *outcome != RunOutcome::Running {
            partial = true;
            continue;
        }
        let Some(range) = window.clip(*started_at, ended_at.unwrap_or(window.as_of)) else {
            continue;
        };
        partial |= open;
        let active = *state == ActivityState::Active;
        agents
            .entry(agent_id.clone())
            .or_default()
            .entry((evidence.issue_id.clone(), run_id.clone()))
            .or_default()
            .push((range.0, range.1, active));
        let owner = owner_user_id
            .filter(|id| *id > 0)
            .map_or_else(|| "unknown".to_owned(), |id| id.to_string());
        per_person
            .entry(owner)
            .or_default()
            .entry(agent_id.clone())
            .or_default()
            .entry((evidence.issue_id.clone(), run_id.clone()))
            .or_default()
            .push((range.0, range.1, active));
        rows.push(json!({"key":evidence.key,"issue_id":evidence.issue_id,"agent_id":agent_id,"run_id":run_id,
            "owner_user_id":owner_user_id,"start":range.0,"end":range.1,"outcome":outcome,"state":state,"partial":open}));
    }
    partial |= rows.is_empty();
    let total = agents
        .into_values()
        .map(covered)
        .fold(0.0, |total, duration| total + duration);
    let people: BTreeMap<_, _> = per_person
        .into_iter()
        .map(|(id, agents)| {
            (
                id,
                agents
                    .into_values()
                    .map(covered)
                    .fold(0.0, |total, duration| total + duration),
            )
        })
        .collect();
    let capacity = super::capacity::compute(facts, members, window, person);
    let denominator = capacity["seconds"].as_f64();
    partial |= capacity["partial"] == true;
    json!({"ai_active_seconds":total,"ai_active_hours":total/3600.0,"per_person_seconds":people,
        "denominator":denominator,"runtime_to_capacity_ratio":denominator.filter(|value|*value>0.0 && !rows.is_empty()).map(|value|total/value),
        "ratio_definition":"runtime_hours_per_available_human_hour","capacity":capacity,
        "sample":rows.len(),"partial":partial,"intervals":rows})
}
