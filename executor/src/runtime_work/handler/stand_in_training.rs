//! Build replay cases only from verified messages. Answers never enter the replay scene.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("invalid_training_case", message)
}

fn quotes(message: &Value, parent: &Value) -> bool {
    parent["id"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && message["quotedMessageId"] == id)
}

fn validate_reply(
    message: &Value,
    possible_parents: &[&Value],
    group: bool,
) -> Result<(), AppIpcError> {
    if let Some(quoted) = message["quotedMessageId"]
        .as_str()
        .filter(|id| !id.is_empty())
    {
        if possible_parents.iter().any(|parent| parent["id"] == quoted) {
            return Ok(());
        }
        return Err(invalid(
            "The message explicitly replies to a different question or answer",
        ));
    }
    if group
        && !message["topicId"].as_str().is_some_and(|topic| {
            !topic.is_empty()
                && possible_parents
                    .iter()
                    .any(|parent| parent["topicId"] == topic)
        })
    {
        return Err(invalid(
            "Feedback in shared resources requires a verified quote or shared topic",
        ));
    }
    Ok(())
}

pub(super) fn identity_learning_role<'a>(
    handler: &RuntimeWorkRpcHandler,
    link: &'a RuntimeTaskLink,
    settings: &Value,
) -> Option<&'a str> {
    let origin = &link.runtime_handle["origin"];
    let role_id = origin["standInId"].as_str().unwrap_or("@primary");
    if origin["type"] != "stand_in_identity"
        || origin["userId"] != settings["userId"]
        || origin["deviceId"] != handler.device_id
        || !settings["lifecycle"]["status"].is_null()
    {
        return None;
    }
    let role = if role_id == "@primary" {
        &settings["primary"]
    } else {
        settings["roles"]
            .as_array()?
            .iter()
            .find(|role| role["id"] == role_id)?
    };
    (role["selfLearningEnabled"] == true
        && role["enabled"] == true
        && handler
            .local_stand_in_role_device(settings, role_id)
            .is_some())
    .then_some(role_id)
}

fn case_evidence(
    binding: &Value,
    task: &str,
    kind: &str,
    scene: &Value,
    actual: Option<&Value>,
    expected: &Value,
) -> Result<Value, AppIpcError> {
    let external = binding["source"].is_object();
    if !matches!(kind, "correction" | "positive" | "demonstration")
        || (kind == "demonstration") != actual.is_none()
        || (!external && actual.is_none())
    {
        return Err(invalid("A correction or positive case needs the original assistant answer; a demonstration needs an observed owner answer"));
    }
    let scene_at = scene["at"]
        .as_i64()
        .ok_or_else(|| invalid("Missing scene time"))?;
    let expected_at = expected["at"]
        .as_i64()
        .ok_or_else(|| invalid("Missing feedback time"))?;
    let recipient_correction =
        external && kind == "correction" && expected["author"] == "participant";
    let valid_scene_author = if external {
        scene["author"] == "participant"
            || (scene["author"] == "owner"
                && binding["source"]["kind"] == "direct"
                && scene["isSelfConversation"] == true
                && expected["author"] == "owner"
                && actual.is_some_and(|answer| quotes(answer, scene)))
    } else {
        scene["author"] == "owner"
    };
    if !valid_scene_author
        || (expected["author"] != "owner" && !recipient_correction)
        || expected["contextOnly"] == true
        || scene["id"] == expected["id"]
    {
        return Err(invalid("The scene must precede attributable feedback"));
    }
    if let Some(answer) = actual {
        if answer["author"] != "assistant"
            || (!external
                && (!scene["turnId"].as_str().is_some_and(|id| !id.is_empty())
                    || answer["turnId"] != scene["turnId"]))
            || answer["id"] == scene["id"]
            || answer["id"] == expected["id"]
            || !answer["at"].as_i64().is_some_and(|t| {
                t >= scene_at
                    && (t < expected_at
                        || (external && t == expected_at && quotes(expected, answer)))
            })
        {
            return Err(invalid(
                "The verified assistant answer must be between the request and owner feedback",
            ));
        }
    } else if expected_at < scene_at || (expected_at == scene_at && !quotes(expected, scene)) {
        return Err(invalid("The owner's demonstration must follow the request"));
    }
    let mut topic = None;
    for message in [Some(scene), actual, Some(expected)].into_iter().flatten() {
        if message["truncated"] == true {
            return Err(invalid(
                "A truncated source message cannot establish a case",
            ));
        }
        if external
            && (scene["conversationId"].as_str().is_none()
                || scene["conversationId"] != message["conversationId"])
        {
            return Err(invalid("Training evidence spans different conversations"));
        }
        if let Some(id) = message["topicId"].as_str().filter(|id| !id.is_empty()) {
            if topic.is_some_and(|prior| prior != id) {
                return Err(invalid("Training evidence spans unrelated topics"));
            }
            topic = Some(id);
        }
    }
    if external {
        // A one-to-one conversation has a single peer. Other resources can contain
        // several participants and unrelated threads, even in one mailbox or issue.
        let group = binding["source"]["kind"] != "direct";
        if group
            && recipient_correction
            && !scene["participantKey"]
                .as_str()
                .is_some_and(|key| !key.is_empty() && expected["participantKey"] == key)
        {
            return Err(invalid(
                "Feedback in a shared resource must come from the original participant",
            ));
        }
        if let Some(answer) = actual {
            validate_reply(answer, &[scene], group)?;
            validate_reply(expected, &[scene, answer], group)?;
        } else {
            validate_reply(expected, &[scene], group)?;
        }
    }
    // Prefer native topic or quote relationships. Otherwise keep an entire external
    // conversation together to avoid testing on a restatement of a training episode.
    let episode = if external {
        topic.or_else(|| {
            let id = scene["id"].as_str()?;
            let replies_to_scene = [actual, Some(expected)]
                .into_iter()
                .flatten()
                .any(|message| message["quotedMessageId"].as_str() == Some(id));
            replies_to_scene.then(|| scene["quotedMessageId"].as_str().unwrap_or(id))
        })
    } else {
        scene["turnId"].as_str()
    };
    let group = format!(
        "{:x}",
        Sha256::digest(json!([task, scene["conversationId"], episode]).to_string())
    );
    let training_case = json!({"roleId":binding["roleId"],"source":binding["source"],"group":group,"kind":kind,
        "scene":scene["content"],"actual":actual.map(|m| &m["content"]),"expected":expected["content"],"expectedAuthor":expected["author"],
        "conversationId":scene["conversationId"],"sceneMessageId":scene["id"],"actualMessageId":actual.map(|m| &m["id"]),
        "actualNativeFinalMessageId":actual.and_then(|m| m.get("nativeFinalReplyItemId"))});
    Ok(
        json!({"taskId":task,"messageId":expected["id"],"role":if expected["author"]=="owner" {"user"} else {"source"},"observedAt":expected_at,
        "excerpt":expected["content"],"trainingCase":training_case}),
    )
}

fn observation_evidence(
    binding: &Value,
    task: &str,
    message: &Value,
    excerpt: &str,
) -> Result<Value, AppIpcError> {
    let at = message["at"]
        .as_i64()
        .ok_or_else(|| invalid("Missing observation time"))?;
    if !binding["source"].is_object()
        || message["contextOnly"] == true
        || message["truncated"] == true
        || excerpt.trim().is_empty()
        || !message["content"]
            .as_str()
            .is_some_and(|text| text.contains(excerpt))
    {
        return Err(invalid(
            "An observation requires an exact excerpt from a current, complete external record",
        ));
    }
    // Even a first-person quotation remains attributed to its source record.
    Ok(
        json!({"taskId":task, "messageId":message["id"], "observedAt":at,
        "role":"source", "excerpt":excerpt, "trainingCase":{
            "roleId":binding["roleId"], "source":binding["source"], "kind":"observation"
        }}),
    )
}

impl RuntimeWorkRpcHandler {
    async fn training_message(
        &self,
        identity: &StandInMcpIdentity,
        task: &str,
        reference: &Value,
    ) -> Result<(Value, Value), AppIpcError> {
        let id = super::stand_in_tasks::required(reference, "id")?;
        let excerpt = super::stand_in_tasks::required(reference, "excerpt")?;
        if excerpt.len() > 1400 {
            return Err(invalid("Each verbatim excerpt must fit in 1400 bytes"));
        }
        if task.starts_with("training-source:") {
            let (binding, mut message) = self
                .verified_connection_training_message(identity, task, reference)
                .await?;
            if message["id"] != id
                || !message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains(excerpt))
            {
                return Err(invalid("Source evidence changed"));
            }
            if message["content"].as_str().unwrap_or_default().len() > 1400 {
                message["content"] = json!(excerpt);
            }
            return Ok((binding, message));
        }
        let link = self
            .local_task_link(task)
            .ok_or_else(|| invalid("Identity conversation missing"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .configured_personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let role_id = identity_learning_role(self, &link, &settings)
            .ok_or_else(|| invalid("Learning is unavailable for this identity"))?;
        let mut read = reference["readArguments"].clone();
        if !read.is_object() {
            return Err(invalid("Missing evidence page arguments"));
        }
        read["taskId"] = json!(task);
        let page = self
            .read_stand_in_conversations(identity, "read_task", &read)
            .await?;
        let mut chunk = page.clone();
        chunk["id"] = page["messageId"].clone();
        let m = page["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&chunk))
            .find(|m| {
                m["id"] == id
                    && m["content"]
                        .as_str()
                        .is_some_and(|content| content.contains(excerpt))
            })
            .ok_or_else(|| {
                invalid("The exact message and excerpt must be present in the evidence page")
            })?;
        let native_final = match (
            m["nativeFinalReplyItemId"].as_str(),
            m["turnId"].as_str(),
            m["nativeReplyItemId"].as_str(),
        ) {
            (Some(final_item), _, _) => Some(final_item),
            (None, Some(turn), Some(item))
                if store
                    .identity_training_reply_seen(identity.user, role_id, task, turn, item, id)
                    .map_err(super::stand_in::settings_error)? =>
            {
                Some(item)
            }
            _ => None,
        };
        let author = match m["role"].as_str() {
            Some("user") if m["trainingOwnerMessage"] == true => "owner",
            Some("assistant") if native_final.is_some() => "assistant",
            _ => {
                return Err(invalid(
                    "A direct case requires an attributable owner message or verified native final answer",
                ))
            }
        };
        let content = m["content"]
            .as_str()
            .filter(|content| {
                content.len() <= 1400
                    && m["contentComplete"] == true
                    && !read["messageContentCursor"].is_string()
            })
            .unwrap_or(excerpt);
        let message = json!({"id":id,"author":author,"content":content,"turnId":m["turnId"],"nativeFinalReplyItemId":native_final,
            "at":timestamp_ms_field(m,"completedAt").or_else(|| timestamp_ms_field(m,"createdAt"))});
        Ok((json!({"roleId":role_id}), message))
    }

    async fn feedback_evidence(
        &self,
        identity: &StandInMcpIdentity,
        task: &str,
        binding: &Value,
        scene: &Value,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let actual = if args["actual"].is_object() {
            let (source, message) = self
                .training_message(identity, task, &args["actual"])
                .await?;
            if &source != binding {
                return Err(invalid("The source changed during review"));
            }
            Some(message)
        } else {
            None
        };
        let (source, expected) = self
            .training_message(identity, task, &args["expected"])
            .await?;
        if &source != binding {
            return Err(invalid("The source changed during review"));
        }
        case_evidence(
            binding,
            task,
            super::stand_in_tasks::required(args, "kind")?,
            scene,
            actual.as_ref(),
            &expected,
        )
    }

    pub(super) async fn save_training_case(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        if !identity.memory_review || identity.review || identity.readonly_worker {
            return Err(AppIpcError::new(
                "permission_denied",
                "Memory review identity required",
            ));
        }
        let task = super::stand_in_tasks::required(args, "taskId")?;
        let gate = self.task_send_gate(&format!("memory-source:{}:{task}", identity.user));
        let _guard = gate.lock().await;
        let (binding, scene) = self
            .training_message(identity, task, &args["scene"])
            .await?;
        let observation = args["kind"] == "observation";
        let evidence = if observation {
            if !args["actual"].is_null() || !args["expected"].is_null() {
                return Err(invalid("Use a feedback case for a pair of messages"));
            }
            let excerpt = super::stand_in_tasks::required(&args["scene"], "excerpt")?;
            observation_evidence(&binding, task, &scene, excerpt)?
        } else {
            self.feedback_evidence(identity, task, &binding, &scene, args)
                .await?
        };
        let content = super::stand_in_tasks::required(args, "content")?;
        let role = binding["roleId"]
            .as_str()
            .ok_or_else(|| invalid("Missing case role"))?;
        let scope = if binding["source"].is_object() {
            crate::task_runtime::personal_stand_in::training_memory_scope(&binding["source"])
        } else if role == "@primary" {
            json!({"kind":"personal"})
        } else {
            json!({"kind":"role","roleId":role})
        };
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| invalid("Missing live memory review"))?;
        self.scheduled_review_run_end(&actor, identity.user, true)?;
        let run = actor.runtime_handle["executionRequest"]["standInSchedule"]["runId"]
            .as_str()
            .ok_or_else(|| invalid("Missing live memory review run"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let write = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    if observation {
                        "observation"
                    } else {
                        "training"
                    },
                    evidence["messageId"]
                ])
                .to_string()
            )
        );
        store
            .record_memory_review_write(identity.user, task, run, &write, true)
            .map_err(super::stand_in::settings_error)?;
        let memory = json!({"evidence":evidence,"content":content,
            "sourceTaskId":task,"scope":scope});
        let settings = store
            .configured_personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let device = self
            .local_stand_in_role_device(&settings, role)
            .ok_or_else(|| invalid("Learning role moved to another device"))?;
        let result = super::stand_in_memory_review::memory_review_save_result(
            store.save_verified_training_memory(identity.user, &device, memory),
        )?;
        store
            .record_memory_review_write(identity.user, task, run, &write, false)
            .map_err(super::stand_in::settings_error)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_observation_can_only_quote_what_the_current_external_record_contains() {
        let binding = json!({"roleId":"support","source":{"kind":"inbox"}});
        let message =
            json!({"id":"m","author":"unknown","content":"I prefer weekend releases.","at":1});
        let build = |binding: &Value, message: &Value, excerpt| {
            observation_evidence(binding, "training-source:inbox", message, excerpt)
        };
        let evidence = build(&binding, &message, "I prefer weekend releases.").unwrap();
        assert_eq!(evidence["role"], "source");
        assert_eq!(evidence["trainingCase"]["kind"], "observation");
        assert!(evidence["trainingCase"]["expectedAuthor"].is_null());
        assert!(build(&binding, &message, "The owner prefers weekend releases").is_err());
        assert!(build(&json!({"roleId":"support"}), &message, "weekend").is_err());
        for key in ["truncated", "contextOnly"] {
            let mut partial = message.clone();
            partial[key] = json!(true);
            assert!(build(&binding, &partial, "weekend").is_err());
        }
    }

    #[test]
    fn self_chat_owner_can_correct_a_verified_reply_to_their_own_question() {
        let binding = json!({"roleId":"engineer","source":{"id":"self","kind":"direct"}});
        let question = json!({"id":"q","author":"owner","at":100,"conversationId":"self","isSelfConversation":true});
        let mut answer = json!({"id":"a","author":"assistant","quotedMessageId":"q","at":110,"conversationId":"self"});
        let feedback = json!({"id":"f","author":"owner","at":120,"conversationId":"self"});
        let build = |source: &Value, scene: &Value, actual: &Value, expected: &Value| {
            case_evidence(
                source,
                "source",
                "correction",
                scene,
                Some(actual),
                expected,
            )
        };
        assert!(build(&binding, &question, &answer, &feedback).is_ok());
        let mut ordinary_chat = question.clone();
        ordinary_chat["isSelfConversation"] = json!(false);
        assert!(build(&binding, &ordinary_chat, &answer, &feedback).is_err());
        let mut group = binding.clone();
        group["source"]["kind"] = json!("group");
        assert!(build(&group, &question, &answer, &feedback).is_err());
        let mut third_party = feedback.clone();
        third_party["author"] = json!("participant");
        assert!(build(&binding, &question, &answer, &third_party).is_err());
        answer["quotedMessageId"] = Value::Null;
        assert!(build(&binding, &question, &answer, &feedback).is_err());
        assert!(case_evidence(
            &binding,
            "source",
            "demonstration",
            &question,
            None,
            &feedback
        )
        .is_err());
    }

    #[test]
    fn native_quotes_establish_order_within_the_same_source_timestamp() {
        let binding = json!({"roleId":"engineer","source":{"id":"chat","kind":"direct"}});
        let question = json!({"id":"q","author":"participant","at":100,"conversationId":"chat"});
        let answer = json!({"id":"a","author":"assistant","quotedMessageId":"q","at":100,"conversationId":"chat"});
        let mut feedback = json!({"id":"f","author":"owner","quotedMessageId":"a","at":100,"conversationId":"chat"});
        let build = |kind: &str, actual: Option<&Value>, expected: &Value| {
            case_evidence(&binding, "source", kind, &question, actual, expected)
        };
        assert!(build("correction", Some(&answer), &feedback).is_ok());
        feedback["quotedMessageId"] = json!("q");
        assert!(build("correction", Some(&answer), &feedback).is_err());
        assert!(build("demonstration", None, &feedback).is_ok());
        feedback["quotedMessageId"] = Value::Null;
        assert!(build("demonstration", None, &feedback).is_err());
        feedback["quotedMessageId"] = json!("a");
        feedback["at"] = json!(99);
        assert!(build("correction", Some(&answer), &feedback).is_err());
    }

    #[test]
    fn group_feedback_must_belong_to_the_question_and_its_participant() {
        let mut source = json!({"roleId":"engineer","source":{"id":"chat","kind":"group"}});
        let question = json!({"id":"q-a","author":"participant","participantKey":"A","at":100,"conversationId":"chat"});
        let mut answer = json!({"id":"a","author":"assistant","quotedMessageId":"q-b","at":100,"conversationId":"chat"});
        let mut feedback = json!({"id":"f","author":"participant","participantKey":"A","quotedMessageId":"a","at":101,"conversationId":"chat"});
        let build = |source: &Value, answer: &Value, feedback: &Value| {
            case_evidence(
                source,
                "training-source:chat",
                "correction",
                &question,
                Some(answer),
                feedback,
            )
        };
        assert!(build(&source, &answer, &feedback).is_err());
        answer["quotedMessageId"] = json!("q-a");
        assert!(build(&source, &answer, &feedback).is_ok());
        feedback["participantKey"] = json!("B");
        assert!(build(&source, &answer, &feedback).is_err());
        feedback["author"] = json!("owner");
        assert!(build(&source, &answer, &feedback).is_ok());
        feedback["quotedMessageId"] = json!("q-b");
        assert!(build(&source, &answer, &feedback).is_err());
        feedback["quotedMessageId"] = Value::Null;
        assert!(build(&source, &answer, &feedback).is_err());
        source["source"]["kind"] = json!("direct");
        assert!(build(&source, &answer, &feedback).is_ok());
        feedback["quotedMessageId"] = json!("q-b");
        assert!(build(&source, &answer, &feedback).is_err());
    }

    #[test]
    fn replay_scene_excludes_future_assistant_answer_and_owner_correction() {
        let binding = json!({"roleId":"engineer","source":{"id":"chat"}});
        let question = json!({"id":"q","author":"participant","at":100,"content":"An operation takes 20 minutes","conversationId":"chat","topicId":"slow"});
        let answer = json!({"id":"a","author":"assistant","at":120,"content":"It is stuck","conversationId":"chat","topicId":"slow"});
        let feedback = json!({"id":"f","author":"owner","at":130,"content":"It is slow but still progressing","conversationId":"chat","topicId":"slow"});
        let build = |answer: &Value, feedback: &Value| {
            case_evidence(
                &binding,
                "training-source:chat",
                "correction",
                &question,
                Some(answer),
                feedback,
            )
        };
        let case = build(&answer, &feedback).unwrap();
        assert_eq!(case["trainingCase"]["scene"], question["content"]);
        assert_eq!(case["trainingCase"]["actual"], answer["content"]);
        assert_eq!(case["trainingCase"]["expected"], feedback["content"]);
        for (field, value) in [
            ("at", json!(90)),
            ("contextOnly", json!(true)),
            ("author", json!("unknown")),
            ("conversationId", json!("other")),
            ("topicId", json!("other")),
        ] {
            let mut invalid = feedback.clone();
            invalid[field] = value;
            assert!(build(&answer, &invalid).is_err());
        }
        let mut unverified_reply = answer;
        unverified_reply["author"] = json!("unknown");
        assert!(build(&unverified_reply, &feedback).is_err());
    }
}
