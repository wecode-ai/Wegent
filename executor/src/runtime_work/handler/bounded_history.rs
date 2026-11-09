//! Model-facing history uses visible text and immutable, scoped continuation pages.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PREFIX: &str = "wework-history:v1:";
const PAGE_BYTES: usize = 64 * 1024;
const CONTENT_BYTES: usize = 8 * 1024;
const PAGE_OVERHEAD: usize = 4096;

#[derive(Deserialize, Serialize)]
struct Cursor {
    binding: String,
    snapshot: String,
    #[serde(flatten)]
    position: Position,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Position {
    Before { end: usize },
    After { start: usize },
    NativeBefore,
    NativeAfter,
    Content { message: usize, offset: usize },
}

#[derive(Deserialize, Serialize)]
struct Snapshot {
    binding: String,
    task: String,
    messages: Vec<Value>,
    before: Option<String>,
    after: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    unknown_timestamps: bool,
    source_may_be_incomplete: bool,
}

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("history_cursor_invalid", message)
}

fn binding(identity: &StandInMcpIdentity, target: &RuntimeTaskLink) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([
                identity.user,
                identity.device,
                identity.task_id,
                identity.role,
                identity.work,
                identity.project,
                identity.coordinator_batch,
                identity.readonly_worker,
                identity.review,
                identity.memory_review,
                target.local_task_id,
                if super::super::conversation_sessions::is_identity_conversation(target) {
                    None
                } else {
                    target.thread_id.clone()
                }
            ])
            .to_string()
            .as_bytes()
        )
    )
}

fn encode(snapshot: &Snapshot, id: &str, position: Position) -> String {
    let cursor = Cursor {
        binding: snapshot.binding.clone(),
        snapshot: id.into(),
        position,
    };
    format!(
        "{PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap())
    )
}

fn requested_cursor(args: &Value) -> Result<Option<Cursor>, AppIpcError> {
    let fields = ["beforeCursor", "afterCursor", "messageContentCursor"];
    let selected: Vec<_> = fields
        .into_iter()
        .filter_map(|field| args.get(field).map(|v| (field, v)))
        .collect();
    if selected.len() > 1 {
        return Err(invalid("Supply one history page or message content cursor"));
    }
    let Some((field, value)) = selected.first() else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .filter(|text| text.len() <= 8192)
        .ok_or_else(|| invalid("Invalid history cursor"))?;
    let cursor: Cursor = text
        .strip_prefix(PREFIX)
        .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| invalid("Invalid history cursor; refresh read_task without a cursor"))?;
    let matches = matches!(
        (field, &cursor.position),
        (
            &"beforeCursor",
            Position::Before { .. } | Position::NativeBefore
        ) | (
            &"afterCursor",
            Position::After { .. } | Position::NativeAfter
        ) | (&"messageContentCursor", Position::Content { .. })
    );
    if !matches {
        return Err(invalid("Cursor is for a different history operation"));
    }
    Ok(Some(cursor))
}

fn directory(handler: &RuntimeWorkRpcHandler, link: &RuntimeTaskLink) -> PathBuf {
    super::super::transcript_transport::snapshot_directory(
        handler.store.index_path().parent().unwrap(),
        &json!({"taskId":link.local_task_id,"threadId":link.thread_id}),
    )
}

async fn save(directory: PathBuf, snapshot: &Snapshot) -> Result<String, AppIpcError> {
    let value =
        serde_json::to_value(snapshot).map_err(|_| invalid("History page is unavailable"))?;
    super::super::transcript_work::run(move |cancel| {
        super::super::transcript_transport::store_native_page(&directory, &value, cancel)
    })
    .await
}

async fn load(directory: PathBuf, cursor: &Cursor) -> Result<Snapshot, AppIpcError> {
    let id = cursor.snapshot.clone();
    let value = super::super::transcript_work::run(move |cancel| {
        super::super::transcript_transport::read_native_page(&directory, &id, cancel)
    })
    .await
    .map_err(|error| match error.code.as_str() {
        "transcript_page_expired" => AppIpcError::new(
            "history_cursor_expired",
            "History cursor expired; refresh read_task without a cursor",
        ),
        _ => AppIpcError::new(
            "history_cursor_unavailable",
            "History page is unavailable; refresh read_task without a cursor",
        ),
    })?;
    serde_json::from_value(value).map_err(|_| invalid("Invalid history snapshot"))
}

impl RuntimeWorkRpcHandler {
    // The caller revalidates the live actor, owner, role, device and source on
    // every page and every content chunk before reaching this projection.
    pub(super) async fn read_bounded_history(
        &self,
        identity: &StandInMcpIdentity,
        link: &RuntimeTaskLink,
        args: &Value,
        limit: usize,
        since: Option<i64>,
        until: Option<i64>,
    ) -> Result<Value, AppIpcError> {
        let read = self.bounded_history_response(identity, link, args, limit, since, until);
        #[cfg(test)]
        if let Some(workers) = self.transcript_test_workers.clone() {
            return super::super::transcript_work::with_test_workers(workers, read).await;
        }
        read.await
    }

    async fn bounded_history_response(
        &self,
        identity: &StandInMcpIdentity,
        link: &RuntimeTaskLink,
        args: &Value,
        limit: usize,
        since: Option<i64>,
        until: Option<i64>,
    ) -> Result<Value, AppIpcError> {
        let cursor = requested_cursor(args)?;
        let bound = binding(identity, link);
        let mut native = None;
        let mut window = (since, until);
        if let Some(cursor) = cursor.as_ref() {
            if cursor.binding != bound {
                return Err(invalid(
                    "Cursor belongs to another conversation or identity",
                ));
            }
            let snapshot = load(directory(self, link), cursor).await?;
            if snapshot.binding != bound || snapshot.task != link.local_task_id {
                return Err(invalid("History snapshot binding changed"));
            }
            if (args.get("since").is_some() && since != snapshot.since)
                || (args.get("until").is_some() && until != snapshot.until)
            {
                return Err(invalid("Cursor preserves the original history time window"));
            }
            window = (snapshot.since, snapshot.until);
            match cursor.position {
                Position::Before { end } => {
                    return page(&snapshot, &cursor.snapshot, limit, false, end)
                }
                Position::After { start } => {
                    return page(&snapshot, &cursor.snapshot, limit, true, start)
                }
                Position::Content { message, offset } => {
                    return content(&snapshot, &cursor.snapshot, message, offset)
                }
                Position::NativeBefore => {
                    native = Some((
                        "beforeCursor",
                        snapshot
                            .before
                            .ok_or_else(|| invalid("No earlier history page"))?,
                    ))
                }
                Position::NativeAfter => {
                    native = Some((
                        "afterCursor",
                        snapshot
                            .after
                            .ok_or_else(|| invalid("No later history page"))?,
                    ))
                }
            }
        }
        let mut payload =
            json!({"taskId":link.local_task_id,"limit":limit,"conversationContextOnly":true});
        if let Some((key, value)) = native.as_ref() {
            payload[*key] = json!(value);
        }
        let mut value = self.transcript(payload).await?;
        super::stand_in_history::filter_history_page(&mut value, window.0, window.1);
        let current = self
            .local_task_link(&link.local_task_id)
            .ok_or_else(|| invalid("History session disappeared"))?;
        let snapshot = Snapshot {
            binding: binding(identity, &current),
            task: current.local_task_id.clone(),
            messages: visible_messages(&value),
            before: (value["hasMoreBefore"] == true)
                .then(|| value["beforeCursor"].as_str().map(str::to_owned))
                .flatten(),
            after: (value["hasMoreAfter"] == true)
                .then(|| value["afterCursor"].as_str().map(str::to_owned))
                .flatten(),
            since: window.0,
            until: window.1,
            unknown_timestamps: value["unknownTimestamps"] == true,
            source_may_be_incomplete: value["fullContent"] != true
                && value["fullItemContent"] != true,
        };
        let id = save(directory(self, &current), &snapshot).await?;
        if native
            .as_ref()
            .is_some_and(|(key, _)| *key == "afterCursor")
        {
            page(&snapshot, &id, limit, true, 0)
        } else {
            page(&snapshot, &id, limit, false, snapshot.messages.len())
        }
    }
}

fn visible_messages(page: &Value) -> Vec<Value> {
    const KEYS: &[&str] = &[
        "id",
        "clientUserMessageId",
        "role",
        "content",
        "status",
        "runtimeStatus",
        "turnId",
        "subtaskId",
        "createdAt",
        "completedAt",
        "messageIndex",
    ];
    page["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|message| {
            if !matches!(message["role"].as_str(), Some("user" | "assistant")) {
                return None;
            }
            let mut message = message.as_object()?.clone();
            message.retain(|key, _| KEYS.contains(&key.as_str()));
            Some(Value::Object(message))
        })
        .collect()
}

fn text_chunk(text: &str, offset: usize) -> Result<(&str, usize), AppIpcError> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err(invalid("Invalid message content offset"));
    }
    let mut end = offset.saturating_add(CONTENT_BYTES).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((&text[offset..end], end))
}

fn preview(snapshot: &Snapshot, id: &str, index: usize) -> Result<Value, AppIpcError> {
    let mut message = snapshot.messages[index].clone();
    let text = message["content"].as_str().unwrap_or_default();
    let (chunk, end) = text_chunk(text, 0)?;
    let total = text.len();
    let chunk = chunk.to_owned();
    message["content"] = json!(chunk);
    message["contentComplete"] = json!(end == total);
    message["totalContentBytes"] = json!(total);
    message["messageContentCursor"] = json!((end < total).then(|| encode(
        snapshot,
        id,
        Position::Content {
            message: index,
            offset: end
        }
    )));
    Ok(message)
}

fn page(
    snapshot: &Snapshot,
    id: &str,
    limit: usize,
    ascending: bool,
    position: usize,
) -> Result<Value, AppIpcError> {
    if position > snapshot.messages.len() {
        return Err(invalid("Invalid history page position"));
    }
    let indices: Box<dyn Iterator<Item = usize>> = if ascending {
        Box::new(position..snapshot.messages.len())
    } else {
        Box::new((0..position).rev())
    };
    let mut messages = Vec::new();
    let mut bytes = PAGE_OVERHEAD;
    for index in indices.take(limit) {
        let message = preview(snapshot, id, index)?;
        let size = message.to_string().len();
        if bytes + size > PAGE_BYTES {
            if messages.is_empty() {
                return Err(invalid("History message metadata exceeds the page budget"));
            }
            break;
        }
        bytes += size;
        messages.push(message);
    }
    let (start, end) = if ascending {
        (position, position + messages.len())
    } else {
        (position - messages.len(), position)
    };
    if !ascending {
        messages.reverse();
    }
    let before = if start > 0 {
        Some(encode(snapshot, id, Position::Before { end: start }))
    } else {
        snapshot
            .before
            .as_ref()
            .map(|_| encode(snapshot, id, Position::NativeBefore))
    };
    let after = if end < snapshot.messages.len() {
        Some(encode(snapshot, id, Position::After { start: end }))
    } else {
        snapshot
            .after
            .as_ref()
            .map(|_| encode(snapshot, id, Position::NativeAfter))
    };
    let unread = messages
        .iter()
        .any(|message| message["contentComplete"] != true);
    let result = json!({"success":true,"taskId":snapshot.task,"messages":messages,
        "hasMoreBefore":before.is_some(),"beforeCursor":before,"hasMoreAfter":after.is_some(),"afterCursor":after,
        "hasMoreContent":unread,"contentMayBeTruncated":unread || snapshot.source_may_be_incomplete,"sourceContentMayBeIncomplete":snapshot.source_may_be_incomplete,"fullContent":!snapshot.source_may_be_incomplete && !unread && start==0 && end==snapshot.messages.len() && snapshot.before.is_none() && snapshot.after.is_none(),
        "unknownTimestamps":snapshot.unknown_timestamps});
    if result.to_string().len() > PAGE_BYTES {
        return Err(invalid("History page exceeds its byte budget"));
    }
    Ok(result)
}

fn content(
    snapshot: &Snapshot,
    id: &str,
    index: usize,
    offset: usize,
) -> Result<Value, AppIpcError> {
    let message = snapshot
        .messages
        .get(index)
        .ok_or_else(|| invalid("Unknown history message"))?;
    let text = message["content"].as_str().unwrap_or_default();
    let (chunk, end) = text_chunk(text, offset)?;
    let result = json!({"success":true,"taskId":snapshot.task,"messageId":message["id"],"role":message["role"],"createdAt":message["createdAt"],"content":chunk,
        "contentOffset":offset,"totalContentBytes":text.len(),"contentComplete":end==text.len(),
        "messageContentCursor":(end<text.len()).then(||encode(snapshot,id,Position::Content{message:index,offset:end}))});
    if result.to_string().len() > PAGE_BYTES {
        return Err(invalid("History content metadata exceeds its byte budget"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        messages: Vec<Value>,
    ) -> (tempfile::TempDir, RuntimeWorkRpcHandler, StandInMcpIdentity) {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.transcript_test_workers = Some(Arc::new(tokio::sync::Semaphore::new(2)));
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let settings = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        settings.personal_stand_in(7, "mac").unwrap();
        let identity = StandInMcpIdentity {
            task_id: "actor".into(),
            user: 7,
            device: "mac".into(),
            role: Some("default".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        };
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:"actor".into(),runtime:"codex".into(),
            runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":"default"},"executionRequest":{"user_id":7}}),..Default::default()});
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:"target".into(),runtime:"chat".into(),
            runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":messages}),..Default::default()});
        (root, handler, identity)
    }

    fn read<'a>(
        handler: &'a RuntimeWorkRpcHandler,
        identity: &'a StandInMcpIdentity,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        // Repeated reads must not inline every native transcript future into one test frame.
        super::super::dispatch::boxed_rpc(move || async move {
            handler
                .read_stand_in_conversations(identity, "read_task", &args)
                .await
        })
    }

    #[tokio::test]
    async fn huge_message_is_lossless_in_chunks_and_excludes_internal_payloads() {
        let text = "公开内容。".repeat(20000);
        let (_root, handler, identity) = fixture(vec![
            json!({"id":"system","role":"developer","content":"internal-canary"}),
            json!({"id":"large","role":"assistant","content":text,"runtimeItems":[{"schema":"internal-canary".repeat(100000)}],"blocks":[{"output":"internal-canary"}]}),
        ]);
        let page = read(&handler, &identity, json!({"taskId":"target","limit":30}))
            .await
            .unwrap();
        assert!(page.to_string().len() <= PAGE_BYTES);
        assert!(!page.to_string().contains("internal-canary"));
        assert_eq!(page["messages"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMoreContent"], true);
        assert_eq!(page["fullContent"], false);
        let mut actual = page["messages"][0]["content"].as_str().unwrap().to_owned();
        let mut cursor = page["messages"][0]["messageContentCursor"].clone();
        while cursor.is_string() {
            let chunk = read(
                &handler,
                &identity,
                json!({"taskId":"target","messageContentCursor":cursor}),
            )
            .await
            .unwrap();
            assert!(chunk.to_string().len() <= PAGE_BYTES);
            actual.push_str(chunk["content"].as_str().unwrap());
            cursor = chunk["messageContentCursor"].clone();
            assert_eq!(chunk["contentComplete"], cursor.is_null());
        }
        assert_eq!(actual, text);
    }

    #[tokio::test]
    async fn byte_bounded_pages_follow_both_snapshot_and_native_cursors_without_skips() {
        let messages=(0..83).map(|index|json!({"id":format!("m{index}"),"role":"assistant","content":"x".repeat(8000)})).collect();
        let (_root, handler, identity) = fixture(messages);
        let mut args = json!({"taskId":"target","limit":30});
        let mut seen = std::collections::HashSet::new();
        let mut forward = None;
        loop {
            let page = read(&handler, &identity, args).await.unwrap();
            assert!(page.to_string().len() <= PAGE_BYTES);
            for message in page["messages"].as_array().unwrap() {
                assert!(seen.insert(message["id"].as_str().unwrap().to_owned()));
            }
            if page["afterCursor"].is_string() {
                forward = Some(page["afterCursor"].clone());
            }
            if page["hasMoreBefore"] != true {
                break;
            }
            args = json!({"taskId":"target","limit":30,"beforeCursor":page["beforeCursor"]});
        }
        assert_eq!(seen.len(), 83);
        let forward = read(
            &handler,
            &identity,
            json!({"taskId":"target","afterCursor":forward.unwrap()}),
        )
        .await
        .unwrap();
        assert!(!forward["messages"].as_array().unwrap().is_empty());
        assert!(forward.to_string().len() <= PAGE_BYTES);
    }

    #[tokio::test]
    async fn cursors_bind_identity_task_thread_type_window_and_expiration() {
        let (_root, handler, identity) = fixture(vec![
            json!({"id":"large","role":"assistant","content":"x".repeat(20000),"createdAt":1500}),
        ]);
        let page = read(
            &handler,
            &identity,
            json!({"taskId":"target","since":"1970-01-01T00:00:01Z"}),
        )
        .await
        .unwrap();
        let cursor = page["messages"][0]["messageContentCursor"].clone();
        assert!(read(
            &handler,
            &identity,
            json!({"taskId":"target","beforeCursor":cursor})
        )
        .await
        .is_err());
        assert!(read(
            &handler,
            &identity,
            json!({"taskId":"target","messageContentCursor":cursor,"since":"1970-01-01T00:00:02Z"})
        )
        .await
        .is_err());
        let mut other = handler.local_task_link("target").unwrap();
        other.local_task_id = "other".into();
        handler.upsert_local_task(other);
        assert!(read(
            &handler,
            &identity,
            json!({"taskId":"other","messageContentCursor":cursor})
        )
        .await
        .is_err());
        let mut changed = identity.clone();
        changed.user = 8;
        assert!(read(
            &handler,
            &changed,
            json!({"taskId":"target","messageContentCursor":cursor})
        )
        .await
        .is_err());
        let mut changed = identity.clone();
        changed.device = "foreign-device".into();
        assert!(read(
            &handler,
            &changed,
            json!({"taskId":"target","messageContentCursor":cursor})
        )
        .await
        .is_err());
        changed = identity.clone();
        changed.role = Some("foreign-role".into());
        assert!(read(
            &handler,
            &changed,
            json!({"taskId":"target","messageContentCursor":cursor})
        )
        .await
        .is_err());
        let decoded = requested_cursor(&json!({"messageContentCursor":cursor}))
            .unwrap()
            .unwrap();
        let target = handler.local_task_link("target").unwrap();
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(directory(&handler, &target).join(format!("{}.native.gz", decoded.snapshot)))
            .unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
            .unwrap();
        assert_eq!(
            read(
                &handler,
                &identity,
                json!({"taskId":"target","messageContentCursor":cursor})
            )
            .await
            .unwrap_err()
            .code,
            "history_cursor_expired"
        );
        handler.store.update_task("target", |target| {
            target.thread_id = Some("new-thread".into())
        });
        assert_eq!(
            read(
                &handler,
                &identity,
                json!({"taskId":"target","messageContentCursor":cursor})
            )
            .await
            .unwrap_err()
            .code,
            "history_cursor_invalid"
        );
    }

    #[tokio::test]
    async fn saved_content_cursor_does_not_outlive_source_authorization() {
        let (_root, handler, mut identity) = fixture(Vec::new());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let source = json!({"providerId":"test","profile":"account","kind":"folder","id":"selected","name":"Selected","policy":{"automatic":true,"askBeforeAct":true}});
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([source]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let work = store
            .ingest_stand_in_message(
                7,
                "default",
                &source,
                &json!({"id":"event","text":"Source event"}),
                None,
            )
            .unwrap();
        let id = work["id"].as_str().unwrap();
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:id.into(),runtime:"chat".into(),
            runtime_handle:json!({"origin":{"type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":id},"executionRequest":{"user_id":7},
                "messages":[{"id":"result","role":"assistant","content":"x".repeat(20000)}]}),..Default::default()});
        identity.task_id = id.into();
        identity.work = Some(id.into());
        let page = read(&handler, &identity, json!({"taskId":id}))
            .await
            .unwrap();
        assert!(page["messages"][0]["messageContentCursor"].is_string());
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert_eq!(read(&handler,&identity,json!({"taskId":id,"messageContentCursor":page["messages"][0]["messageContentCursor"]})).await.unwrap_err().code,"permission_denied");
    }
}
