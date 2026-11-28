//! Measure verified owner follow-ups against actual sends with a fully reviewed follow-up window.
use super::personal_stand_in::{read_personal, stand_in_identities, training_source_granted};
use super::*;
use std::collections::BTreeMap;

const DAY: i64 = 24 * 60 * 60 * 1000;
const FEEDBACK: &str = "stand_in_rework_feedback";
use super::stand_in_training_connections::{
    identity_source, identity_task, DELIVERY, LEGACY_DELIVERY,
};

fn answer_key(source_id: &str, native_id: &str) -> String {
    LocalTaskStore::coordination_event_version(&json!([source_id, native_id]))
}

/// Retain only the native association when the bounded recent-lesson store rotates.
pub(super) fn link_owner_correction(
    connection: &Connection,
    user: i64,
    memory: &Value,
) -> Result<(), TaskRuntimeError> {
    let evidence = &memory["evidence"];
    let case = &evidence["trainingCase"];
    if case["kind"] != "correction" || case["expectedAuthor"] != "owner" {
        return Ok(());
    }
    let (Some(memory_id), Some(role), Some(actual), Some(followup), Some(at)) = (
        memory["id"].as_str(),
        case["roleId"].as_str(),
        case["actualMessageId"].as_str(),
        evidence["messageId"].as_str(),
        evidence["observedAt"].as_i64(),
    ) else {
        return Ok(());
    };
    let (source, source_id) = if case["source"].is_object() {
        (
            case["source"].clone(),
            LocalTaskStore::training_source_id(role, &case["source"]),
        )
    } else if let Some(task) = evidence["taskId"].as_str().filter(|id| !id.is_empty()) {
        (identity_source(task), task.to_owned())
    } else {
        return Ok(());
    };
    let metadata = json!({"userId":user,"roleId":role,"answerKey":answer_key(&source_id,actual),
        "source":source,"requestId":case["sceneMessageId"],"threadId":case["conversationId"],
        "directFinalVerified":case["actualNativeFinalMessageId"].as_str().is_some_and(|id|!id.is_empty()),"followupMessageId":followup,"at":at});
    connection.execute(
        "INSERT OR IGNORE INTO loop_items(id,resource_type,user_id,metadata,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?5)",
        params![
            format!("stand-in-rework:{memory_id}"),
            FEEDBACK,
            user,
            metadata.to_string(),
            now()
        ],
    )?;
    Ok(())
}

pub(super) fn withdraw_correction(
    connection: &Connection,
    user: i64,
    memory_id: &str,
) -> Result<(), TaskRuntimeError> {
    // Keep only the opaque answer key and time so forgetting cannot turn a failed request into a success.
    connection.execute(
        "UPDATE loop_items SET metadata=json_remove(metadata,'$.followupMessageId'),updated_at=?4
        WHERE id=?1 AND resource_type=?2 AND user_id=?3",
        params![
            format!("stand-in-rework:{memory_id}"),
            FEEDBACK,
            user,
            now()
        ],
    )?;
    Ok(())
}

type Versions = (String, String);

#[derive(Default)]
struct Counts {
    total: usize,
    rework: usize,
}

impl Counts {
    fn add(&mut self, rework: bool) {
        self.total += 1;
        self.rework += usize::from(rework);
    }

    fn rate(&self) -> f64 {
        self.rework as f64 / self.total as f64
    }
}

#[derive(Default)]
struct Cohort {
    count: Counts,
    first: Option<i64>,
    last: i64,
    by_source: BTreeMap<String, Counts>,
}

#[derive(Default)]
struct Request {
    answers: Vec<(String, i64)>,
    versions: Option<Versions>,
    unattributed: bool,
    unseen: bool,
}

impl Request {
    fn add_delivery(&mut self, source: &str, row: &Value) {
        let (Some(native_id), Some(sent)) = (
            row["nativeMessageId"].as_str().filter(|s| !s.is_empty()),
            row["sentAt"].as_i64().filter(|at| *at > 0),
        ) else {
            self.unattributed = true;
            return;
        };
        if row["ambiguous"] == true {
            self.unattributed = true;
            return;
        }
        let observed = row["historySeenAt"].as_i64().filter(|at| *at > 0);
        self.unseen |= observed.is_none();
        let evidence_id = row["evidenceMessageId"].as_str().unwrap_or(native_id);
        self.answers
            .push((answer_key(source, evidence_id), observed.unwrap_or(sent)));
        let (Some(ghost), Some(memory)) = (
            row["ghostVersion"].as_str().filter(|s| !s.is_empty()),
            row["memoryVersion"].as_str().filter(|s| !s.is_empty()),
        ) else {
            self.unattributed = true;
            return;
        };
        let versions = (ghost.to_owned(), memory.to_owned());
        self.unattributed |= self
            .versions
            .as_ref()
            .is_some_and(|existing| existing != &versions);
        self.versions = Some(versions);
    }
}

#[derive(Default)]
struct Report {
    complete: Counts,
    confirmed: usize,
    pending: usize,
    incomplete: usize,
    unattributed: usize,
    cohorts: BTreeMap<Versions, Cohort>,
}

type Feedback = HashMap<String, Vec<(i64, bool)>>;

impl Report {
    fn observe(
        &mut self,
        cluster: Option<String>,
        request: Request,
        coverage: &Value,
        feedback: &Feedback,
        now_ms: i64,
    ) {
        if request.unattributed {
            self.unattributed += 1;
            return;
        }
        let (Some(versions), Some(first)) = (
            request.versions,
            request.answers.iter().map(|(_, sent)| *sent).min(),
        ) else {
            self.unattributed += 1;
            return;
        };
        let through = first.saturating_add(DAY);
        if through > now_ms {
            self.pending += 1;
            return;
        }
        if request.unseen {
            self.incomplete += 1;
            return;
        }
        let intervals = coverage.as_array().map(Vec::as_slice).unwrap_or_default();
        let i = intervals.partition_point(|v| v[0].as_i64().is_some_and(|from| from <= first));
        if i == 0
            || !intervals[i - 1][1]
                .as_i64()
                .is_some_and(|end| end >= through)
        {
            self.incomplete += 1;
            return;
        }
        let mut owner_rework = false;
        let mut withdrawn = false;
        for (answer, sent) in &request.answers {
            for &(at, present) in feedback.get(answer).into_iter().flatten() {
                if at >= *sent && at < through {
                    owner_rework |= present;
                    withdrawn |= !present;
                }
            }
        }
        if withdrawn && !owner_rework {
            self.incomplete += 1;
            return;
        }
        self.complete.add(owner_rework);
        let cohort = self.cohorts.entry(versions).or_default();
        cohort.first = Some(cohort.first.map_or(first, |before| before.min(first)));
        cohort.last = request
            .answers
            .iter()
            .fold(cohort.last, |last, (_, sent)| last.max(*sent));
        cohort.count.add(owner_rework);
        if let Some(cluster) = cluster {
            cohort
                .by_source
                .entry(cluster)
                .or_default()
                .add(owner_rework);
        }
    }

    fn json(&self, role: &str) -> Value {
        let cohorts: Vec<_> = self
            .cohorts
            .iter()
            .map(|((ghost, memory), c)| {
                json!({
                    "ghostVersion":ghost,"memoryVersion":memory,"completeRequests":c.count.total,
                    "ownerReworkRequests":c.count.rework,"firstSentAt":c.first,"lastSentAt":c.last
                })
            })
            .collect();
        let comparison = compare(&self.cohorts);
        let mut report = json!({"roleId":role,"windowHours":24,"completeRequests":self.complete.total,
            "ownerReworkRequests":self.complete.rework,"confirmedReworkRequests":self.confirmed,
            "outsideRateReworkRequests":self.confirmed - self.complete.rework,"pendingRequests":self.pending,
            "incompleteRequests":self.incomplete,"unattributedRequests":self.unattributed,
            "cohorts":cohorts,"comparison":comparison});
        if comparison["dimension"] == "ghost" {
            if let Some(current) = comparison["currentVersion"].as_str() {
                let active = self
                    .cohorts
                    .iter()
                    .filter(|((ghost, _), _)| ghost == current);
                if active.clone().nth(1).is_some() {
                    report["memoryComparison"] = compare_versions(active, false);
                }
            }
        }
        report
    }
}

fn compare(cohorts: &BTreeMap<Versions, Cohort>) -> Value {
    let by_ghost = cohorts
        .keys()
        .next()
        .is_some_and(|(first, _)| cohorts.keys().any(|(ghost, _)| ghost != first));
    compare_versions(cohorts.iter(), by_ghost)
}

fn compare_versions<'a>(
    cohorts: impl Iterator<Item = (&'a Versions, &'a Cohort)>,
    by_ghost: bool,
) -> Value {
    let insufficient = json!({"status":"insufficient"});
    let mut versions: BTreeMap<&str, (i64, BTreeMap<&str, Counts>)> = BTreeMap::new();
    for ((ghost, memory), cohort) in cohorts {
        let (last, sources) = versions
            .entry(if by_ghost { ghost } else { memory })
            .or_default();
        *last = (*last).max(cohort.last);
        for (source, count) in &cohort.by_source {
            let combined = sources.entry(source).or_default();
            combined.total += count.total;
            combined.rework += count.rework;
        }
    }
    let mut ordered: Vec<_> = versions.into_iter().collect();
    ordered.sort_by_key(|(_, (at, _))| *at);
    if ordered.len() < 2 {
        return insufficient;
    }
    let (current, (current_at, current_sources)) = ordered.pop().unwrap();
    let (baseline, (baseline_at, baseline_sources)) = ordered.pop().unwrap();
    if current_at == baseline_at {
        return insufficient;
    }
    if ordered
        .last()
        .is_some_and(|(_, (at, _))| *at == baseline_at)
    {
        return json!({"status":"insufficient","dimension":if by_ghost {"ghost"} else {"memory"},
            "currentVersion":current});
    }
    let mut changes = Vec::new();
    let (mut baseline_count, mut current_count) = (0, 0);
    for (source, before) in baseline_sources {
        if let Some(after) = current_sources.get(source) {
            changes.push(after.rate() - before.rate());
            baseline_count += before.total;
            current_count += after.total;
        }
    }
    if changes.is_empty() {
        return json!({"status":"insufficient","dimension":if by_ghost {"ghost"} else {"memory"},
            "currentVersion":current,"baselineVersion":baseline,"matchedSources":0});
    }
    let (difference, lower, upper) = median_interval(&mut changes);
    let status = if upper < 0.0 {
        "lower"
    } else if lower > 0.0 {
        "higher"
    } else {
        "inconclusive"
    };
    json!({"status":status,"dimension":if by_ghost {"ghost"} else {"memory"},"currentVersion":current,
        "baselineVersion":baseline,"matchedSources":changes.len(),"baselineRequests":baseline_count,
        "currentRequests":current_count,"difference":difference,"lowerBound":lower,"upperBound":upper})
}

/// Exact two-sided sign interval for the median of independent conversation-level changes.
/// The interval is conservative for ties. Each chat supplies one paired change.
fn median_interval(changes: &mut [f64]) -> (f64, f64, f64) {
    changes.sort_unstable_by(f64::total_cmp);
    let n = changes.len();
    let middle = n / 2;
    let median = (changes[middle] + changes[(n - 1) / 2]) / 2.0;
    if n < 6 {
        return (median, -1.0, 1.0);
    }

    // Scale binomial masses by the modal mass instead of starting at 2^-n,
    // which underflows for large n. Symmetry gives the two-sided normalization.
    let mut weights = Vec::with_capacity(middle + 1);
    let mut weight = 1.0;
    weights.push(weight);
    for index in (1..=middle).rev() {
        weight *= index as f64 / (n - index + 1) as f64;
        weights.push(weight);
    }
    let total = 2.0 * weights.iter().sum::<f64>() - if n.is_multiple_of(2) { 1.0 } else { 0.0 };
    let mut tail = 0.0;
    let mut rank = 0;
    for (index, weight) in weights.into_iter().rev().enumerate() {
        tail += weight;
        if tail > 0.025 * total {
            break;
        }
        rank = index;
    }
    (median, changes[rank], changes[n - 1 - rank])
}

fn rows(
    connection: &Connection,
    resource: &str,
    user: i64,
    role: &str,
) -> Result<Vec<Value>, TaskRuntimeError> {
    let mut q = connection.prepare_cached(
        "SELECT metadata FROM loop_items WHERE resource_type IN (?1,?4)
        AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.roleId')=?3",
    )?;
    let rows = q.query_map(
        params![
            resource,
            user,
            role,
            if resource == DELIVERY {
                LEGACY_DELIVERY
            } else {
                resource
            }
        ],
        |row| row.get::<_, String>(0),
    )?;
    rows.map(|row| {
        serde_json::from_str(&row?).map_err(|e| TaskRuntimeError::Invalid(e.to_string()))
    })
    .collect()
}

/// Older direct-chat corrections had no separate feedback row. Project only linkage, not private text.
fn retained_owner_feedback(
    connection: &Connection,
    user: i64,
    role: &str,
) -> Result<Vec<Value>, TaskRuntimeError> {
    let mut sql=connection.prepare_cached("SELECT json_extract(m.metadata,'$.evidence.trainingCase.source'),
        json_extract(m.metadata,'$.evidence.taskId'),json_extract(m.metadata,'$.evidence.trainingCase.sceneMessageId'),
        json_extract(m.metadata,'$.evidence.trainingCase.actualMessageId'),json_extract(m.metadata,'$.evidence.messageId'),
        json_extract(m.metadata,'$.evidence.observedAt'),
        json_extract(m.metadata,'$.evidence.trainingCase.actualNativeFinalMessageId'),
        json_extract(m.metadata,'$.evidence.trainingCase.conversationId')
        FROM loop_items m LEFT JOIN loop_items f ON f.id='stand-in-rework:'||m.id
        WHERE m.resource_type='stand_in_memory' AND json_extract(m.metadata,'$.userId')=?1
          AND json_extract(m.metadata,'$.evidence.trainingCase.roleId')=?2
          AND json_extract(m.metadata,'$.evidence.trainingCase.kind')='correction'
          AND json_extract(m.metadata,'$.evidence.trainingCase.expectedAuthor')='owner'
          AND json_type(m.metadata,'$.evidence.taskId')='text'
          AND json_type(m.metadata,'$.evidence.trainingCase.sceneMessageId')='text'
          AND json_type(m.metadata,'$.evidence.trainingCase.actualMessageId')='text'
          AND json_type(m.metadata,'$.evidence.messageId')='text' AND json_type(m.metadata,'$.evidence.observedAt')='integer'
          AND (f.id IS NULL OR (json_type(f.metadata,'$.followupMessageId')='text' AND json_extract(f.metadata,'$.requestId') IS NULL))")?;
    let rows = sql.query_map(params![user, role], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    rows.map(|row| {
        let (raw, task, request, actual, followup, at, final_id, thread) = row?;
        let (source, source_id) = if let Some(raw) = raw {
            let source =
                serde_json::from_str(&raw).map_err(|e| TaskRuntimeError::Invalid(e.to_string()))?;
            let key = LocalTaskStore::training_source_id(role, &source);
            (source, key)
        } else {
            (identity_source(&task), task)
        };
        Ok(
            json!({"source":source,"answerKey":answer_key(&source_id,&actual),"requestId":request,
            "followupMessageId":followup,"at":at,"threadId":thread,
            "directFinalVerified":final_id.is_some_and(|id|!id.is_empty())}),
        )
    })
    .collect()
}

impl LocalTaskStore {
    pub fn issue_rework_source_ids(
        &self,
        user: i64,
        role: &str,
    ) -> Result<HashSet<String>, TaskRuntimeError> {
        let db = self.connection()?;
        let mut query = db.prepare_cached(
            "SELECT DISTINCT json_extract(metadata,'$.source') FROM loop_items
             WHERE resource_type IN (?1,?2) AND json_extract(metadata,'$.userId')=?3
               AND json_extract(metadata,'$.roleId')=?4 AND json_extract(metadata,'$.source.providerId')=?5")?;
        let rows = query.query_map(
            params![
                DELIVERY,
                FEEDBACK,
                user,
                role,
                super::personal_stand_in::ISSUE_COMMENTS_PROVIDER
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.map(|row| {
            let source = serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            Ok(Self::training_source_id(role, &source))
        })
        .collect()
    }

    /// Counts derive exclusively from delivered replies, verified owner feedback and native review checkpoints.
    pub fn stand_in_rework_report(
        &self,
        user: i64,
        device: &str,
        role_id: &str,
        role_device: &str,
        authorized_sources: &HashSet<String>,
    ) -> Result<Value, TaskRuntimeError> {
        self.stand_in_rework_report_at(
            user,
            device,
            role_id,
            role_device,
            chrono::Utc::now().timestamp_millis(),
            authorized_sources,
        )
    }

    fn stand_in_rework_report_at(
        &self,
        user: i64,
        device: &str,
        role_id: &str,
        role_device: &str,
        at: i64,
        authorized_sources: &HashSet<String>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let settings = read_personal(&tx, user, device)?;
        let mut report = Report::default();
        let role = stand_in_identities(&settings).into_iter().find(|role| {
            role["id"] == role_id
                && role["executionDeviceId"] == role_device
                && role["enabled"] == true
                && role["selfLearningEnabled"] == true
        });
        let Some(role) = role.filter(|_| settings["lifecycle"]["status"].is_null()) else {
            return Ok(report.json(role_id));
        };
        let mut coverage = BTreeMap::new();
        let mut requests = BTreeMap::<(String, Option<String>, String), Request>::new();
        let visible_source = |source: &Value| -> Result<Option<String>, TaskRuntimeError> {
            if let Some(task) = identity_task(source) {
                return Ok(authorized_sources.contains(task).then(|| task.to_owned()));
            }
            if !source["enabledAfter"].is_string() || !training_source_granted(&role, source) {
                return Ok(None);
            }
            let id = Self::training_source_id(role_id, source);
            if source["providerId"] == super::personal_stand_in::ISSUE_COMMENTS_PROVIDER
                && (!authorized_sources.contains(&id)
                    || source["profile"] == "local"
                        && !super::stand_in_memories::local_issue_visible(&tx, &role, source)?)
            {
                return Ok(None);
            }
            Ok(Some(id))
        };
        let mut answered_requests = HashMap::new();
        let mut disputed = HashSet::new();
        for row in rows(&tx, DELIVERY, user, role_id)? {
            let source = &row["source"];
            if row["deviceId"] != device {
                continue;
            }
            let Some(source_id) = visible_source(source)? else {
                continue;
            };
            if !coverage.contains_key(&source_id) {
                let mut state = super::stand_in_memory_progress::read(&tx, user, &source_id)?;
                coverage.insert(source_id.clone(), state["coverageIntervals"].take());
            }
            let Some(request_id) = row["requestId"].as_str().filter(|id| !id.is_empty()) else {
                report.unattributed += 1;
                continue;
            };
            let cluster = if identity_task(source).is_some()
                || source["providerId"] == super::personal_stand_in::DINGTALK_PROVIDER
            {
                Some(source_id.clone())
            } else {
                row["threadId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(|id| answer_key(&source_id, id))
            };
            let group = (source_id.clone(), cluster, request_id.to_owned());
            let evidence_id = row["evidenceMessageId"]
                .as_str()
                .or_else(|| row["nativeMessageId"].as_str());
            if let Some(id) = evidence_id {
                let key = answer_key(&source_id, id);
                if row["ambiguous"] == true {
                    disputed.insert(key);
                } else if identity_task(source).is_none()
                    || (row["historySeenAt"].is_i64() && row["evidenceMessageId"].is_string())
                {
                    answered_requests.insert(key, group.clone());
                }
            }
            requests
                .entry(group)
                .or_default()
                .add_delivery(&source_id, &row);
        }
        let cutoff = at;
        let mut feedback = Feedback::new();
        let mut confirmed = HashSet::new();
        let mut links = rows(&tx, FEEDBACK, user, role_id)?;
        links.extend(retained_owner_feedback(&tx, user, role_id)?);
        for row in links {
            if let (Some(key), Some(at)) = (row["answerKey"].as_str(), row["at"].as_i64()) {
                if disputed.contains(key) {
                    continue;
                }
                let present = row["followupMessageId"].is_string();
                feedback
                    .entry(key.to_owned())
                    .or_default()
                    .push((at, present));
                if present && at <= cutoff {
                    if let Some(request) = answered_requests.get(key) {
                        confirmed.insert(request.clone());
                    } else if let (Some(source), Some(request)) = (
                        visible_source(&row["source"])?,
                        row["requestId"].as_str().filter(|id| !id.is_empty()),
                    ) {
                        if identity_task(&row["source"]).is_none()
                            || row["directFinalVerified"] == true
                        {
                            let cluster = if row["source"]["providerId"]
                                == super::personal_stand_in::DINGTALK_PROVIDER
                                || identity_task(&row["source"]).is_some()
                            {
                                Some(source.clone())
                            } else {
                                row["threadId"]
                                    .as_str()
                                    .filter(|id| !id.is_empty())
                                    .map(|id| answer_key(&source, id))
                            };
                            confirmed.insert((source, cluster, request.to_owned()));
                        }
                    }
                }
            }
        }
        report.confirmed = confirmed.len();
        for ((source, cluster, _), request) in requests {
            report.observe(cluster, request, &coverage[&source], &feedback, at);
        }
        Ok(report.json(role_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_corrections_count_once_only_with_matching_actual_delivery_and_complete_coverage() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("db")).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"","preferences":"",
            "connections":[{"providerId":super::super::personal_stand_in::DINGTALK_PROVIDER,"profile":"p",
                "kind":"direct","id":"contact","name":"contact","policy":{"automatic":true,"askBeforeAct":false}}]});
        let settings = store.save_personal_stand_in(7, "device", settings).unwrap();
        let source = &settings["primary"]["connections"][0];
        let first = chrono::Utc::now().timestamp_millis();
        let later = first + 2 * DAY;
        let epoch = LocalTaskStore::training_source_id("@primary", source);
        for (i, (since, through)) in [(first, first + DAY), (later, later + DAY)]
            .into_iter()
            .enumerate()
        {
            let run = format!("run-{i}");
            let state = store.memory_review_progress(7, &epoch).unwrap();
            let state = store
                .record_memory_review_page(
                    7,
                    &epoch,
                    &run,
                    through,
                    state["version"].as_i64().unwrap(),
                    json!([]),
                    Some(since),
                )
                .unwrap();
            store
                .complete_memory_review_source(
                    7,
                    &epoch,
                    &run,
                    state["version"].as_i64().unwrap(),
                    true,
                )
                .unwrap();
        }
        let receipt = |request: &str, reply: &str, at: i64, memory: Value| {
            let delivery = json!({"userId":7,"roleId":"@primary","deviceId":"device","source":source,"requestId":request,
                "nativeMessageId":reply,"sentAt":at+30,"historySeenAt":(request!="unseen").then_some(at),
                "ghostVersion":"ghost","memoryVersion":memory});
            store
                .connection()
                .unwrap()
                .execute(
                    "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
                VALUES (?1,?2,?3,'x','x')",
                    params![reply, DELIVERY, delivery.to_string()],
                )
                .unwrap();
        };
        receipt("first", "a", first, json!("m"));
        receipt("first", "b", first + 10, json!("m"));
        receipt("second", "c", later, json!("m"));
        receipt("gap", "d", first + DAY - 1, json!("m"));
        receipt("unseen", "unseen", first, json!("m"));
        receipt("awaiting", "e", first + 4 * DAY, json!("m"));
        receipt("no-version", "f", first, Value::Null);
        receipt("mixed", "g", first, json!("m"));
        receipt("mixed", "h", first + 1, json!("m2"));
        let scope = super::super::personal_stand_in::connection_memory_scope(source);
        let correction = |who: &str, reply: &str, id: &str, at: i64| {
            store.save_verified_training_memory(7,"device",json!({"scope":scope,"content":"A verified correction.",
                "evidence":{"taskId":epoch,"messageId":id,"observedAt":at,"trainingCase":{
                    "roleId":"@primary","source":source,"kind":"correction","expectedAuthor":who,"actualMessageId":reply}}
            })).unwrap()
        };
        let a = correction("owner", "a", "human1", first + 1);
        let b = correction("owner", "b", "human2", first + 15);
        correction("participant", "c", "participant", later + 1);
        correction("owner", "c", "too-late", later + DAY);
        correction("owner", "d", "gap-correction", first + DAY + 2);
        correction("owner", "h", "mixed-version-correction", first + 5);

        // A retained, independently verified historical correction has no versioned send receipt.
        let historical=store.save_verified_training_memory(7,"device",json!({"scope":scope,"content":"A historical correction.",
            "evidence":{"taskId":epoch,"messageId":"legacy-followup","observedAt":first+2,"trainingCase":{
                "roleId":"@primary","source":source,"kind":"correction","expectedAuthor":"owner",
                "sceneMessageId":"legacy-question","actualMessageId":"legacy-answer"}}
        })).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "DELETE FROM loop_items WHERE id=?1",
                [format!(
                    "stand-in-rework:{}",
                    historical["id"].as_str().unwrap()
                )],
            )
            .unwrap();
        let report = || {
            store
                .stand_in_rework_report_at(
                    7,
                    "device",
                    "@primary",
                    "device",
                    first + 4 * DAY,
                    &HashSet::new(),
                )
                .unwrap()
        };
        let metrics = report();
        assert_eq!(
            store
                .stand_in_rework_report(
                    7,
                    "device",
                    "@primary",
                    "different-target",
                    &HashSet::new()
                )
                .unwrap()["cohorts"],
            json!([])
        );
        assert_eq!(metrics["completeRequests"], 2);
        assert_eq!(metrics["ownerReworkRequests"], 1);
        assert_eq!(metrics["confirmedReworkRequests"], 5);
        assert_eq!(metrics["outsideRateReworkRequests"], 4);
        assert_eq!(metrics["pendingRequests"], 1);
        assert_eq!(metrics["incompleteRequests"], 2);
        assert_eq!(metrics["unattributedRequests"], 2);
        assert_eq!(metrics["comparison"]["status"], "insufficient");
        store
            .delete_stand_in_memory(7, a["id"].as_str().unwrap(), 1)
            .unwrap();
        assert_eq!(report()["completeRequests"], 2);
        store
            .delete_stand_in_memory(7, b["id"].as_str().unwrap(), 1)
            .unwrap();
        let metrics = report();
        assert_eq!(metrics["completeRequests"], 1);
        assert_eq!(metrics["ownerReworkRequests"], 0);
        assert_eq!(metrics["incompleteRequests"], 3);
        let mut settings = settings;
        settings["primary"]["connections"] = json!([]);
        store.save_personal_stand_in(7, "device", settings).unwrap();
        assert_eq!(report()["cohorts"], json!([]));
    }

    #[test]
    fn direct_owner_corrections_need_a_visible_final_answer_even_without_a_versioned_delivery() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("db")).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"] =
            json!({"enabled":true,"selfLearningEnabled":true,"prompt":"","preferences":""});
        store.save_personal_stand_in(7, "device", settings).unwrap();
        for (turn, item, final_id) in [
            ("one", "assistant-progress", None),
            ("two", "assistant-final", Some("native-item")),
        ] {
            store.save_verified_training_memory(7,"device",json!({
                "scope":{"kind":"personal"},"content":"Verified relative to the direct history",
                "evidence":{"taskId":"task","messageId":format!("follow-{turn}"),"observedAt":1200,
                    "trainingCase":{"roleId":"@primary","source":null,"kind":"correction","expectedAuthor":"owner",
                      "sceneMessageId":turn,"actualMessageId":item,"actualNativeFinalMessageId":final_id}}
            })).unwrap();
        }
        let authorized = HashSet::from(["task".to_owned()]);
        let report = store
            .stand_in_rework_report_at(7, "device", "@primary", "device", 1300, &authorized)
            .unwrap();
        assert_eq!(report["confirmedReworkRequests"], 1);
        assert_eq!(report["outsideRateReworkRequests"], 1);
        assert_eq!(report["completeRequests"], 0);
        let hidden = store
            .stand_in_rework_report_at(7, "device", "@primary", "device", 1300, &HashSet::new())
            .unwrap();
        assert_eq!(hidden["confirmedReworkRequests"], 0);
    }

    #[test]
    fn comparisons_require_shared_conversations_and_bound_uncertainty_at_the_conversation_level() {
        let mut report = Report::default();
        let mut observe = |source: &str, ghost: &str, first: i64, rework: bool, count: usize| {
            let cohort = report
                .cohorts
                .entry((ghost.into(), "memory".into()))
                .or_default();
            cohort.last = first;
            cohort.by_source.insert(
                source.into(),
                Counts {
                    total: count,
                    rework: if rework { count } else { 0 },
                },
            );
        };
        observe("old-only", "v1", 1, true, 2000);
        observe("new-only", "v2", 2, false, 2000);
        assert_eq!(compare(&report.cohorts)["status"], "insufficient");
        for i in 0..9 {
            let source = format!("shared-{i}");
            report
                .cohorts
                .get_mut(&("v1".into(), "memory".into()))
                .unwrap()
                .by_source
                .insert(
                    source.clone(),
                    Counts {
                        total: 5,
                        rework: 1,
                    },
                );
            report
                .cohorts
                .get_mut(&("v2".into(), "memory".into()))
                .unwrap()
                .by_source
                .insert(
                    source,
                    Counts {
                        total: 5,
                        rework: 0,
                    },
                );
            if i == 4 {
                assert_eq!(compare(&report.cohorts)["status"], "inconclusive");
            }
            if i == 5 {
                assert_eq!(compare(&report.cohorts)["status"], "lower");
            }
        }
        let comparison = compare(&report.cohorts);
        assert_eq!(comparison["status"], "lower");
        assert_eq!(comparison["matchedSources"], 9);
        assert_eq!(comparison["baselineRequests"], 45);
        assert_eq!(comparison["difference"], -0.2);
        let request = |ghost: &str, at| Request {
            answers: vec![(format!("answer-{ghost}"), at)],
            versions: Some((ghost.into(), "changed".into())),
            ..Default::default()
        };
        report.observe(
            Some("shared-0".into()),
            request("pending", DAY),
            &json!([]),
            &Feedback::new(),
            DAY + 1,
        );
        report.observe(
            Some("shared-0".into()),
            request("incomplete", 4),
            &json!([]),
            &Feedback::new(),
            DAY + 10,
        );
        assert_eq!(report.pending, 1);
        assert_eq!(report.incomplete, 1);
        assert_eq!(compare(&report.cohorts), comparison);
        assert_eq!(
            median_interval(&mut [-0.2, 0.1, 0.0, -0.2, 0.0, -0.1]),
            (-0.05, -0.2, 0.1)
        );
        let mut many: Vec<_> = (0..5000).map(|i| i as f64 / 5000.0).collect();
        let (_, lower, upper) = median_interval(&mut many);
        assert!(0.48 < lower && lower < 0.49 && 0.51 < upper && upper < 0.52);
        let mut newest = Cohort {
            last: 3,
            ..Default::default()
        };
        newest.by_source.insert(
            "shared-0".into(),
            Counts {
                total: 2,
                rework: 1,
            },
        );
        report
            .cohorts
            .insert(("v2".into(), "changed".into()), newest);
        let result = report.json("role");
        assert_eq!(result["comparison"]["dimension"], "ghost");
        let within_ghost = &result["memoryComparison"];
        assert_eq!(within_ghost["dimension"], "memory");
        assert_eq!(within_ghost["currentVersion"], "changed");
        assert_eq!(within_ghost["baselineVersion"], "memory");
        assert_eq!(within_ghost["matchedSources"], 1);
        assert_eq!(within_ghost["baselineRequests"], 5);
    }
}
