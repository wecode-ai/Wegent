//! Missing calendars and overlapping capacity declarations never invent a baseline.
use super::*;
use std::collections::BTreeMap;

pub(super) fn compute(
    facts: &[Evidence],
    members: &BTreeSet<i32>,
    window: Window,
    person: Option<i32>,
) -> Value {
    let mut intervals = BTreeMap::<(i32, String, DateTime<Utc>, DateTime<Utc>), f64>::new();
    let mut partial = false;
    for fact in facts {
        let Fact::Capacity {
            user_id,
            calendar_id,
            available_seconds,
            member_from,
            member_until,
        } = &fact.fact
        else {
            continue;
        };
        if person.is_some_and(|id| id != *user_id) {
            continue;
        }
        let Some((start, end)) = window.clip(*member_from, *member_until) else {
            continue;
        };
        let entire = seconds(*member_from, *member_until);
        let value = if start == *member_from && end == *member_until {
            *available_seconds
        } else if *available_seconds == entire {
            seconds(start, end)
        } else {
            partial = true;
            continue;
        };
        let key = (*user_id, calendar_id.clone(), start, end);
        if let Some(previous) = intervals.insert(key, value)
            && previous != value
        {
            partial = true;
        }
    }
    let expected = person.map_or_else(|| members.clone(), |id| BTreeSet::from([id]));
    let present: BTreeSet<_> = intervals.keys().map(|(id, ..)| *id).collect();
    partial |= intervals.is_empty() || !expected.is_subset(&present);
    let mut previous = BTreeMap::new();
    let mut rows = Vec::new();
    let mut total = 0.0;
    let mut ordered: Vec<_> = intervals.into_iter().collect();
    ordered.sort_by_key(|((id, _, start, end), _)| (*id, *start, *end));
    for ((id, calendar, start, end), value) in ordered {
        if previous.insert(id, end).is_some_and(|last| last > start) {
            partial = true;
        }
        total += value;
        rows.push(json!({"user_id":id,"calendar_id":calendar,"start":start,"end":end,"available_seconds":value}));
    }
    json!({"seconds":(!partial).then_some(total),"partial":partial,"intervals":rows})
}
