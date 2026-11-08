//! Private project routing state shares the Executor database, never project chat history.
use super::stand_in_processing::write;
use super::*;

const KIND: &str = "project_coordination_state";

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

pub fn context_id(target: &Value) -> String {
    format!(
        "project:{}",
        LocalTaskStore::coordination_event_version(&json!([
            target["projectStore"],
            target["projectId"],
            target["groupId"],
            target["userId"],
            target["deviceId"],
            target["binding"]["generation"]
        ]))
    )
}

fn read_on(connection: &Connection, target: &Value) -> Result<Value, TaskRuntimeError> {
    check_target(target)?;
    let id = context_id(target);
    let mut state = get_item_from(connection, &id, KIND)?
        .map(|row| row.metadata)
        .unwrap_or_else(|| json!({"id":id,"version":0,"known":{},"events":[],"receipts":{}}));
    if !state["target"].is_null()
        && state["target"]["binding"]["generation"] != target["binding"]["generation"]
    {
        return Err(TaskRuntimeError::VersionConflict);
    }
    state["target"] = target.clone();
    Ok(state)
}

fn save_on(connection: &Connection, state: &mut Value) -> Result<(), TaskRuntimeError> {
    state["version"] = json!(state["version"].as_i64().unwrap_or(0) + 1);
    write(connection, KIND, state)
}

fn check_target(target: &Value) -> Result<(), TaskRuntimeError> {
    if target["binding"]["enabled"] != true
        || target["binding"]["userId"] != target["userId"]
        || target["binding"]["deviceId"] != target["deviceId"]
        || !target["userId"].as_i64().is_some_and(|user| user >= 0)
        || ["projectId", "groupId", "deviceId", "projectStore"]
            .iter()
            .any(|key| !target[*key].as_str().is_some_and(|value| !value.is_empty()))
        || !target["binding"]["generation"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    {
        return Err(invalid("Project routing ownership is unavailable"));
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn register_project_router_target(&self, target: &Value) -> Result<(), TaskRuntimeError> {
        check_target(target)?;
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = context_id(target);
        if let Some(row) = get_item_from(&tx, &id, KIND)? {
            if row.metadata["target"] == *target {
                return Ok(());
            }
        }
        let mut state = json!({"id":id,"target":target,"version":0,"known":{},"events":[],"receipts":{},"batch":null,"snapshot":null,"error":null,"questions":{}});
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn project_router_target(&self, id: &str) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let state = get_item_from(&connection, id, KIND)?
            .ok_or(TaskRuntimeError::TaskNotFound)?
            .metadata;
        let target = state["target"].clone();
        check_target(&target)?;
        if context_id(&target) != id {
            return Err(invalid("Project coordination context identity changed"));
        }
        Ok(target)
    }

    pub fn project_router_state(&self, target: &Value) -> Result<Value, TaskRuntimeError> {
        check_target(target)?;
        let connection = self.connection()?;
        read_on(&connection, target)
    }

    pub fn project_router_snapshot(
        &self,
        target: &Value,
        source: &Value,
        events: &[Value],
    ) -> Result<Value, TaskRuntimeError> {
        check_target(target)?;
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"].is_object() || !state["error"].is_null() {
            return Ok(json!({"skip":true}));
        }
        let cutoff = target["binding"]["sourceCutoff"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .ok_or_else(|| invalid("Project source cutoff is unavailable"))?;
        // Refresh retained inputs against current visibility and ownership. A pending
        // comment must not resurrect work that somebody has already taken over.
        let issues = source["issues"]
            .as_array()
            .ok_or_else(|| invalid("Missing current project Issues"))?;
        state["events"].as_array_mut().unwrap().retain_mut(|event| {
            let Some(issue) = issues.iter().find(|issue| issue["id"] == event["issueId"]) else {
                return false;
            };
            event["issue"] = issue.clone();
            event["binding"] = issue["binding"].clone();
            true
        });
        if let Some(questions) = state["questions"].as_object_mut() {
            questions.retain(|id, _| issues.iter().any(|issue| issue["id"] == *id));
        }
        for event in events {
            let id = event["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("Project source event has no identity"))?;
            let at = event["receivedAt"]
                .as_str()
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                .ok_or_else(|| invalid("Project source event has no receive time"))?;
            if at < cutoff || state["known"].get(id).is_some() {
                continue;
            }
            state["known"][id] = json!(true);
            if let (Some(questions), Some(issue)) = (
                state["questions"].as_object_mut(),
                event["issueId"].as_str(),
            ) {
                questions.remove(issue);
            }
            let mut pending = event.clone();
            pending["status"] = json!("pending");
            state["events"].as_array_mut().unwrap().push(pending);
        }
        let mut pending: Vec<Value> = state["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["status"] == "pending")
            .cloned()
            .collect();
        // Deferred items cannot occupy every batch slot and starve new input.
        pending.sort_by_key(|event| {
            event["notBefore"]
                .as_str()
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                .filter(|at| *at > Utc::now())
        });
        pending.truncate(100);
        let snapshot = json!({"id":Uuid::new_v4().to_string(),"context":{"id":context_id(target),"kind":"project","enabled":true,"revision":target["binding"]["generation"]},
            "source":source,"events":pending,"now":now(),"force":state["force"]==true,"target":target});
        state["snapshot"] = snapshot.clone();
        state["lastCheckAt"] = json!(now());
        if pending.is_empty() {
            state["force"] = json!(false);
            state["nextWakeAt"] = Value::Null;
            state["snapshot"] = Value::Null;
        }
        save_on(&tx, &mut state)?;
        tx.commit()?;
        if pending.is_empty() {
            Ok(json!({"skip":true}))
        } else {
            Ok(snapshot)
        }
    }

    pub fn commit_project_router_plan(
        &self,
        target: &Value,
        payload: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        check_target(target)?;
        let id = payload["snapshotId"]
            .as_str()
            .ok_or_else(|| invalid("Missing project routing snapshot"))?;
        let digest = Self::coordination_event_version(payload);
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if let Some(receipt) = state["receipts"].get(id) {
            if receipt["digest"] != digest {
                return Err(TaskRuntimeError::VersionConflict);
            }
            return Ok(receipt["result"].clone());
        }
        let snapshot = state["snapshot"].clone();
        if snapshot["id"] != id
            || snapshot["context"]["revision"] != target["binding"]["generation"]
            || state["batch"].is_object()
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let actions = payload["actions"]
            .as_array()
            .filter(|actions| actions.len() <= 100)
            .ok_or_else(|| invalid("Invalid project routing plan"))?;
        let mut selected = HashSet::new();
        let mut assess = Vec::new();
        for action in actions {
            let ids = action["eventIds"]
                .as_array()
                .filter(|ids| !ids.is_empty())
                .ok_or_else(|| invalid("Select project source events"))?;
            if !matches!(
                action["kind"].as_str(),
                Some("assess" | "continue_work" | "wait_for_work")
            ) {
                return Err(invalid("Unsupported project routing action"));
            }
            for event in ids {
                let event_id = event
                    .as_str()
                    .ok_or_else(|| invalid("Invalid project source identity"))?;
                let source = snapshot["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|source| source["id"] == *event)
                    .ok_or_else(|| invalid("Project source event is outside the snapshot"))?;
                if !selected.insert(event_id.to_owned()) {
                    return Err(invalid("Project source event is selected twice"));
                }
                let received = snapshot["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|event| event["sourceKey"] == source["sourceKey"])
                    .filter_map(|event| {
                        event["receivedAt"]
                            .as_str()
                            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                    })
                    .min()
                    .ok_or_else(|| invalid("Missing source receive time"))?;
                let now = Utc::now();
                let deferred = source["notBefore"]
                    .as_str()
                    .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
                if deferred.is_some_and(|at| at > now)
                    || (state["force"] != true && received + chrono::Duration::minutes(5) > now)
                {
                    return Err(invalid("The project source window is not due"));
                }
                if action["kind"] == "assess" {
                    if !source["binding"].is_null() {
                        return Err(invalid(
                            "Existing Issue work retains its original lifecycle",
                        ));
                    }
                    assess.push(source.clone());
                } else {
                    if source["binding"]["workId"] != action["workId"]
                        || !action["workId"].is_string()
                    {
                        return Err(invalid("Existing Issue work binding changed"));
                    }
                    for pending in state["events"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .filter(|pending| pending["id"] == *event)
                    {
                        pending["status"] = json!("handled");
                    }
                }
            }
        }
        if !assess.is_empty() {
            let instructions = payload["assessmentInstructions"]
                .as_str()
                .filter(|text| !text.is_empty() && text.len() <= 20000)
                .ok_or_else(|| invalid("Missing project assessment instructions"))?;
            state["batch"] = json!({"id":id,"status":"pending","events":assess,"source":snapshot["source"],"target":target,
                "taskId":format!("project-assessment-{}",Self::coordination_event_version(&json!([context_id(target),id]))),"attempt":0,"instructions":instructions});
        }
        state["force"] = json!(false);
        state["nextWakeAt"] = payload["nextWakeAt"].clone();
        state["snapshot"] = Value::Null;
        let result = json!({"accepted":true,"snapshotId":id});
        state["receipts"][id] = json!({"digest":digest,"result":result});
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn update_project_router_batch(
        &self,
        target: &Value,
        batch_id: &str,
        update: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["id"] != batch_id {
            return Err(TaskRuntimeError::VersionConflict);
        }
        for (key, value) in update
            .as_object()
            .ok_or_else(|| invalid("Invalid assessment update"))?
        {
            state["batch"][key] = value.clone();
        }
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn finish_project_router_assessment(
        &self,
        target: &Value,
        batch_id: &str,
        output: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["id"] != batch_id {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if state["batch"]["decisions"].is_array() {
            return Ok(());
        }
        let batch = state["batch"].clone();
        let decisions = output["decisions"]
            .as_array()
            .filter(|rows| rows.len() <= 100)
            .ok_or_else(|| invalid("The project assessment did not return valid decisions"))?;
        let mut chosen = HashSet::new();
        let mut dispatched = HashSet::new();
        let mut effects = Vec::new();
        for decision in decisions {
            let ids = decision["eventIds"]
                .as_array()
                .filter(|ids| !ids.is_empty())
                .ok_or_else(|| invalid("Every project decision requires source events"))?;
            let kind = decision["kind"]
                .as_str()
                .ok_or_else(|| invalid("Invalid project decision"))?;
            if !matches!(kind, "dispatch_issue" | "ignore" | "defer" | "ask") {
                return Err(invalid("Unsupported project decision"));
            }
            let mut events = Vec::new();
            for id in ids {
                let id = id
                    .as_str()
                    .ok_or_else(|| invalid("Invalid project source identity"))?;
                let event = batch["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|event| event["id"] == id)
                    .ok_or_else(|| invalid("Project decision is outside its source batch"))?;
                if !chosen.insert(id.to_owned()) {
                    return Err(invalid("A project source event was resolved twice"));
                }
                events.push(event);
            }
            if kind == "dispatch_issue" {
                let issue = decision["issueId"]
                    .as_str()
                    .ok_or_else(|| invalid("Select the original Issue"))?;
                if !dispatched.insert(issue.to_owned())
                    || events
                        .iter()
                        .any(|event| event["issueId"] != issue || !event["binding"].is_null())
                {
                    return Err(invalid("Preserve the original Issue and its existing work"));
                }
                let item = batch["source"]["issues"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["id"] == issue)
                    .ok_or_else(|| invalid("The Issue is outside the project source"))?;
                effects.push(json!({"commandId":Self::coordination_event_version(&json!([context_id(target),batch_id,issue])),"eventIds":ids,"issueId":issue,"status":"pending",
                    "input":{"generation":target["binding"]["generation"],"deviceId":target["deviceId"],"projectVersion":batch["source"]["project"]["version"],"groupVersion":batch["source"]["group"]["version"],"issueId":issue,"issueVersion":item["version"]}}));
                continue;
            }
            let reason = decision["reason"]
                .as_str()
                .filter(|reason| !reason.trim().is_empty() && reason.len() <= 2000)
                .ok_or_else(|| invalid("A short handling reason is required"))?;
            if kind == "defer"
                && !decision["at"]
                    .as_str()
                    .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                    .is_some_and(|at| at > Utc::now())
            {
                return Err(invalid("Deferral requires a future timestamp"));
            }
            if kind == "defer" {
                let at = DateTime::parse_from_rfc3339(decision["at"].as_str().unwrap()).unwrap();
                let current = state["nextWakeAt"]
                    .as_str()
                    .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
                if current.map_or(true, |current| at < current) {
                    state["nextWakeAt"] = decision["at"].clone();
                }
            }
            for event in events {
                for pending in state["events"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .filter(|pending| pending["id"] == event["id"])
                {
                    pending["status"] = json!(if kind == "defer" {
                        "pending"
                    } else {
                        "handled"
                    });
                    if kind == "defer" {
                        pending["notBefore"] = decision["at"].clone();
                    }
                }
                if kind == "ask" {
                    state["questions"][event["issueId"].as_str().unwrap()] =
                        json!({"question":reason,"issueId":event["issueId"],"batchId":batch_id});
                }
            }
        }
        if chosen.len() != batch["events"].as_array().unwrap().len() {
            return Err(invalid(
                "The project assessment left source events unresolved",
            ));
        }
        state["batch"]["decisions"] = output["decisions"].clone();
        state["batch"]["effects"] = json!(effects);
        state["batch"]["status"] = json!("dispatching");
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_project_router_effect(
        &self,
        target: &Value,
        batch_id: &str,
        command: &str,
        result: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["id"] != batch_id {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let effect = state["batch"]["effects"]
            .as_array_mut()
            .ok_or_else(|| invalid("Missing project decisions"))?
            .iter_mut()
            .find(|effect| effect["commandId"] == command)
            .ok_or_else(|| invalid("Unknown project command receipt"))?;
        if result["accepted"] != true {
            return Err(invalid("The project command was not accepted"));
        }
        effect["status"] = json!("accepted");
        effect["result"] = result.clone();
        let events = effect["eventIds"].as_array().unwrap().clone();
        for event in state["events"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|event| events.contains(&event["id"]))
        {
            event["status"] = json!("handled");
        }
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn reject_stale_project_router_effect(
        &self,
        target: &Value,
        batch_id: &str,
        command: &str,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["id"] != batch_id {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let effect = state["batch"]["effects"]
            .as_array_mut()
            .ok_or_else(|| invalid("Missing project decisions"))?
            .iter_mut()
            .find(|effect| effect["commandId"] == command)
            .ok_or_else(|| invalid("Unknown project command receipt"))?;
        if effect["status"] == "accepted" {
            return Err(invalid("An accepted command cannot be rejected"));
        }
        effect["status"] = json!("stale");
        state["force"] = json!(true);
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn settle_project_router_batch(&self, target: &Value) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["status"] == "dispatching"
            && state["batch"]["effects"].as_array().is_some_and(|effects| {
                effects
                    .iter()
                    .all(|effect| matches!(effect["status"].as_str(), Some("accepted" | "stale")))
            })
        {
            state["lastBatch"] = state["batch"].clone();
            state["batch"] = Value::Null;
            state["events"]
                .as_array_mut()
                .unwrap()
                .retain(|event| event["status"] == "pending");
            save_on(&tx, &mut state)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn project_router_wake(&self, target: &Value) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read_on(&tx, target)?;
        if state["batch"]["status"] == "failed" && state["batch"]["decisions"].is_null() {
            state["lastBatch"] = state["batch"].clone();
            state["batch"] = Value::Null;
        }
        state["force"] = json!(true);
        state["error"] = Value::Null;
        state["snapshot"] = Value::Null;
        save_on(&tx, &mut state)?;
        tx.commit()?;
        Ok(())
    }
}
