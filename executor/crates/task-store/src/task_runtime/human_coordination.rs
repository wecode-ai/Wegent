use super::*;
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.to_owned())
}

fn projected_assignments(
    conn: &Connection,
    issue: &str,
    state: &Value,
) -> Result<(Vec<Value>, bool), TaskRuntimeError> {
    let mut assignments = Vec::new();
    let mut waiting = false;
    for entry in state["last_batch"].as_array().into_iter().flatten() {
        let human = entry["assignee_type"] == "human";
        let status: String = if human {
            conn.query_row(
                "SELECT CASE WHEN current_delivery_id IS NOT NULL THEN 'completed'
                             WHEN deleted_at IS NOT NULL THEN 'cancelled' ELSE 'pending' END
                 FROM loop_items WHERE parent_id=?1 AND resource_type='task' AND id=?2",
                params![issue, entry["human_assignment_id"].as_str()],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT status FROM loop_item_executions
                 WHERE loop_item_id=?1 AND json_valid(execution_payload)
                   AND json_extract(execution_payload,'$.dispatch_id')=?2
                   AND json_extract(execution_payload,'$.coordination_round_id')=?3
                   AND json_extract(execution_payload,'$.assignment_id')=?4
                 ORDER BY id DESC LIMIT 1",
                params![
                    issue,
                    state["payload"]["dispatch_id"].as_str(),
                    state["last_round"].as_str(),
                    entry["assignment_id"].as_str()
                ],
                |r| r.get(0),
            )?
        };
        waiting |= !TERMINAL_EXECUTION_STATUSES.contains(&status.as_str());
        let mut assignment = json!({
            "assigneeId":entry["assignee_id"],"assigneeType":entry["assignee_type"],
            "assignmentId":entry["assignment_id"],"status":status
        });
        if human {
            assignment["humanAssignmentId"] = entry["human_assignment_id"].clone();
        } else {
            assignment["executionId"] = entry["execution_id"].clone();
        }
        assignments.push(assignment);
    }
    Ok((assignments, waiting))
}

impl LocalTaskStore {
    pub fn human_issue_coordination(
        &self,
        action: &str,
        actor: i64,
        project: &str,
        input: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        let issue = required_string(input, "loopItemId")?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(if action == "get" {
            TransactionBehavior::Deferred
        } else {
            TransactionBehavior::Immediate
        })?;
        let item = get_item_from(&tx, issue, "task")?
            .filter(|i| i.cloud_project_id.as_deref() == Some(project))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let stored_dispatch = item.metadata["human_coordination_dispatch"].as_str();
        let group = &item.metadata["collaboration_group"];
        let legacy_dispatch;
        let (dispatch, mut state): (&str, Value) = if let Some(dispatch) = stored_dispatch {
            let stored: String = tx.query_row(
                "SELECT metadata FROM loop_items WHERE resource_type='issue_coordination' AND id=?1 AND loop_item_id=?2",
                params![dispatch, issue],
                |r| r.get(0),
            )?;
            (
                dispatch,
                serde_json::from_str(&stored)
                    .map_err(|_| invalid("Invalid coordination activity"))?,
            )
        } else if group["leader"]["kind"] == "human" {
            legacy_dispatch = format!(
                "issue-coordination:{:x}",
                Sha256::digest(
                    json!([issue, group, item.metadata["assignment_history"]]).to_string()
                )
            );
            (
                legacy_dispatch.as_str(),
                json!({"round":1,"payload":{"dispatch_id":legacy_dispatch,"collaboration_group":group}}),
            )
        } else {
            return if action == "get" {
                Ok(Value::Null)
            } else {
                Err(TaskRuntimeError::VersionConflict)
            };
        };
        let snapshot = &state["payload"]["collaboration_group"];
        let project_row =
            get_item_from(&tx, project, "project")?.ok_or(TaskRuntimeError::ProjectNotFound)?;
        let current = collaboration_group(&project_row, required_string(snapshot, "id")?).ok();
        let leader = &snapshot["leader"];
        let active = current
            .as_ref()
            .is_some_and(|g| g["leader"]["id"] == leader["id"] && g["leader"]["kind"] == "human")
            && project_row.status.as_deref() == Some("active")
            && item.metadata["collaboration_group"]["id"] == snapshot["id"];
        let allowed = active
            && leader["kind"] == "human"
            && leader["id"].as_str() == Some(&actor.to_string());
        let member_identity = |m: &Value| {
            (
                m["kind"].as_str().unwrap_or_default().to_owned(),
                m["id"].as_str().unwrap_or_default().to_owned(),
            )
        };
        let live_members: HashSet<_> = current
            .as_ref()
            .and_then(|g| g["members"].as_array())
            .into_iter()
            .flatten()
            .map(member_identity)
            .collect();
        let members: Vec<_> = snapshot["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| {
                (m["id"] != leader["id"] || m["kind"] != leader["kind"])
                    && live_members.contains(&member_identity(m))
            })
            .cloned()
            .collect();
        let round = state["round"]
            .as_u64()
            .ok_or_else(|| invalid("Invalid coordination round"))?;
        let (assignments, waiting) = projected_assignments(&tx, issue, &state)?;
        let open = state["decision"].is_null() && item.status.as_deref() != Some("completed");
        if action == "get" {
            return Ok(
                json!({"dispatchId":dispatch,"roundId":round.to_string(),"members":members,"leader":leader,"stages":snapshot["stages"],"assignments":assignments,"waitingForMembers":waiting,"canCoordinate":allowed && open && !waiting}),
            );
        }
        if !allowed || input["dispatchId"] != dispatch {
            return Err(invalid("Current human leader authority is required"));
        }
        let submitted = required_string(input, "roundId")?;
        let identity = json!([project, issue, dispatch, submitted]);
        let message_id = format!(
            "issue-coordination:{:x}",
            Sha256::digest(identity.to_string())
        );
        let request_hash = format!(
            "{:x}",
            Sha256::digest(json!([action, actor, input]).to_string())
        );
        let saved: Option<String> = tx
            .query_row(
                "SELECT metadata FROM loop_item_comments WHERE message_id=?1",
                [&message_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            let metadata: Value = serde_json::from_str(&saved)
                .map_err(|_| invalid("Invalid coordination activity"))?;
            return if metadata["requestHash"] == request_hash {
                Ok(metadata["response"].clone())
            } else {
                Err(TaskRuntimeError::VersionConflict)
            };
        }
        if !open || waiting || submitted != round.to_string() {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if stored_dispatch.is_none() {
            tx.execute("INSERT INTO loop_items(id,loop_item_id,resource_type,created_at,updated_at,metadata,assignee_user_id) VALUES (?1,?2,'issue_coordination',?3,?3,?4,?5)",params![dispatch,issue,now(),state.to_string(),actor])?;
            tx.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.human_coordination_dispatch',?1) WHERE id=?2",params![dispatch,issue])?;
        }
        let sender_name = leader["name"].as_str().unwrap_or_default().to_owned();
        let (response, content, activity) = match action {
            "submit" => {
                let items = input["items"]
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| invalid("Empty assignment batch"))?;
                let mut payload = state["payload"].clone();
                payload["collaboration_group"]["members"] = json!(members);
                let turn = RoundOwner {
                    project,
                    issue,
                    priority: item.priority.as_deref().unwrap_or("none"),
                    execution: None,
                    actor,
                    payload: &payload,
                };
                let dispatched = dispatch_assignments(&tx, &turn, submitted, items)?;
                let content = round_assignment::assignment_summary(&dispatched);
                state["last_batch"] = json!(dispatched);
                state["last_round"] = json!(submitted);
                state["round"] = json!(round + 1);
                (
                    json!({"round_id":submitted,"assignments":dispatched}),
                    content,
                    json!({"activity_type":"manager_assignment","dispatch_assignments":dispatched,"dispatch_role":"manager"}),
                )
            }
            "decide" => {
                let target = required_string(input, "targetStatus")?;
                required_string(input, "reason")?;
                required_string(input, "idempotencyKey")?;
                if !matches!(
                    target,
                    "inbox" | "pending" | "in_progress" | "in_review" | "completed"
                ) {
                    return Err(invalid("Invalid manager decision status"));
                }
                project_status::validate(&project_row.metadata, target)?;
                tx.execute("UPDATE loop_items SET status=?1,updated_by_user_id=?2,version=version+1,updated_at=?3,completed_at=CASE WHEN ?1='completed' THEN ?3 ELSE NULL END WHERE id=?4",params![target,actor,now(),issue])?;
                if item.status.as_deref() != Some(target) {
                    local_automation::on_status_changed(&tx, issue, item.status.as_deref(), None)?;
                }
                let content = input["comment"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .unwrap_or(required_string(input, "reason")?);
                state["decision"] = input.clone();
                (
                    json!({"target_status":target}),
                    content.to_owned(),
                    json!({"activity_type":"manager_decision","target_status":target,"reason":input["reason"]}),
                )
            }
            _ => return Err(invalid("Unknown coordination action")),
        };
        let mut activity = activity;
        activity["dispatch_id"] = json!(dispatch);
        activity["coordination_round_id"] = json!(submitted);
        activity["requestHash"] = json!(request_hash);
        activity["response"] = response.clone();
        record_rows::insert_comment_with_id(
            &tx,
            &LocalCommentCreate {
                project_id: project.into(),
                task_id: issue.into(),
                sender_type: "user".into(),
                sender_id: actor.to_string(),
                sender_name,
                content,
                client_message_id: None,
                reply_to_message_id: None,
                metadata: activity,
            },
            "completed",
            message_id,
        )?;
        tx.execute("UPDATE loop_items SET metadata=?1,updated_at=?2,version=version+1 WHERE id=?3 AND resource_type='issue_coordination'",params![state.to_string(),now(),dispatch])?;
        tx.commit()?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeliveryCreate, DeliveryFinalize};
    #[test]
    fn human_coordination_waits_for_delivery_and_accepts_only_one_authorized_decision() {
        verify_human_coordination(false);
    }

    #[test]
    fn historical_human_assignment_coordinates_without_writing_on_read() {
        verify_human_coordination(true);
    }

    fn verify_human_coordination(historical: bool) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("issues.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Human coordination"})).unwrap())
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                serde_json::from_value(json!({"name":"Inspector"})).unwrap(),
            )
            .unwrap();
        let leader = json!({"kind":"human","id":"0","name":"Owner"});
        let group = json!({"id":"group","leader":leader,"members":[leader,{"kind":"agent","id":agent.id},{"kind":"human","id":"42","name":"Reviewer"}],"stages":[]});
        let project = store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: project.version,
                    collaboration_groups: Some(json!([group])),
                    ..Default::default()
                },
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Review","assignee_group_id":"group"}))
                    .unwrap(),
            )
            .unwrap();
        if historical {
            let conn = store.connection().unwrap();
            conn.execute("DELETE FROM loop_items WHERE resource_type='issue_coordination' AND loop_item_id=?1",[&issue.id]).unwrap();
            conn.execute("UPDATE loop_items SET metadata=json_remove(metadata,'$.human_coordination_dispatch') WHERE id=?1",[&issue.id]).unwrap();
            conn.execute("UPDATE loop_items SET metadata='{}' WHERE resource_type='issue_receipt' AND parent_id=?1",[&issue.id]).unwrap();
        }
        let get = json!({"loopItemId":issue.id});
        let call =
            |op, user, input: &Value| store.human_issue_coordination(op, user, &project.id, input);
        let view = call("get", 0, &get).unwrap();
        assert_eq!(view["canCoordinate"], true);
        if historical {
            let before = store.connection().unwrap().total_changes();
            assert_eq!(
                store.assignment_receipts(&project.id, &issue.id).unwrap()[0]["target_id"],
                "0"
            );
            call("get", 0, &get).unwrap();
            assert_eq!(store.connection().unwrap().total_changes(), before);
        }
        let batch = json!({"loopItemId":issue.id,"roundId":"1","dispatchId":view["dispatchId"],"items":[{"assignment_id":"review","assignee_type":"human","assignee_id":"42","title":"Review","instructions":"Record findings"},{"assignment_id":"inspect","assignee_type":"agent","assignee_id":agent.id,"title":"Inspect","instructions":"Review implementation"}]});
        assert!(call("submit", 42, &batch).is_err());
        let mut invalid_batch = batch.clone();
        let mut outside = batch["items"][0].clone();
        outside["assignment_id"] = json!("second");
        outside["assignee_id"] = json!("99");
        invalid_batch["items"].as_array_mut().unwrap().push(outside);
        assert!(call("submit", 0, &invalid_batch).is_err());
        assert_eq!(store.list_tasks(&project.id).unwrap().len(), 1);
        let first = call("submit", 0, &batch).unwrap();
        assert!(first["assignments"][0]["human_assignment_id"].is_string());
        assert_eq!(call("submit", 0, &batch).unwrap(), first);
        assert_eq!(
            store.assignment_receipts(&project.id, &issue.id).unwrap()[0]["target_id"],
            "0"
        );
        let decision = json!({"loopItemId":issue.id,"roundId":"2","dispatchId":view["dispatchId"],"targetStatus":"completed","reason":"Reviewed","idempotencyKey":"decision"});
        let waiting = call("get", 0, &get).unwrap();
        assert_eq!(waiting["assignments"].as_array().unwrap().len(), 2);
        assert_eq!(waiting["waitingForMembers"], true);
        assert!(call("decide", 0, &decision).is_err());
        let member = store
            .list_tasks(&project.id)
            .unwrap()
            .into_iter()
            .find(|i| i.parent_id.as_deref() == Some(&issue.id))
            .unwrap();
        let delivery = store
            .create_delivery(
                &project.id,
                &member.id,
                true,
                DeliveryCreate {
                    title: "Review".into(),
                    markdown: "Findings".into(),
                    source_task: None,
                    chat: None,
                },
            )
            .unwrap();
        store
            .finalize_delivery(&member.id, &delivery.id, DeliveryFinalize::default())
            .unwrap();
        assert!(call("decide", 0, &decision).is_err());
        let execution = store
            .claim_next_execution_with_catalog(Some("runner-a"), "runner-a", 300, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            execution.id,
            first["assignments"][1]["execution_id"].as_i64().unwrap()
        );
        store
            .complete_execution(execution.id, Some("Reviewed"))
            .unwrap();
        call("decide", 0, &decision).unwrap();
        call("decide", 0, &decision).unwrap();
        assert_eq!(
            store
                .get_task(&project.id, &issue.id)
                .unwrap()
                .status
                .as_deref(),
            Some("completed")
        );
        assert_eq!(
            store
                .list_comments(&project.id, &issue.id, 0)
                .unwrap()
                .iter()
                .filter(|c| c.sender_type == "user")
                .count(),
            2
        );
    }
}
