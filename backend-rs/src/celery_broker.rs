// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Celery (kombu) task publication for indexing work the source detaches from
//! the request that schedules it.
//!
//! The source calls `index_document_task.delay(**payload)` from request
//! handlers (`app/api/endpoints/internal/conversion_callback.py:333`;
//! `app/services/knowledge/orchestrator.py:2419,2537`). Publishing that task is
//! an observable request-owned side effect:
//!
//! 1. Celery generates the task id client-side before the broker round trip
//!    (`celery/app/base.py:839`), so the handler returns an id that already
//!    names the message.
//! 2. `send_task` registers the Redis result channel for that id before it
//!    publishes (`celery/app/base.py:946` -> `celery/backends/redis.py:415-417`
//!    -> `:170-181`): `SUBSCRIBE celery-task-meta-<id>`. The source
//!    `AsyncResult` is dropped when the handler returns, which runs
//!    `result.py:416-420` -> `backends/redis.py:182-186`: `UNSUBSCRIBE`.
//! 3. kombu declares the queue once per channel and then publishes
//!    (`kombu/transport/redis.py:1015-1061`): the declaration is a
//!    `MULTI`/`LLEN` priority-size pipeline plus `SADD` on the binding set, and
//!    the message itself is an `LPUSH` of the protocol-v2 JSON envelope
//!    (`kombu/transport/redis.py:1034-1039`).
//!
//! This module reproduces that behavior for the source's `wegent_online`
//! queue. [`CeleryBroker`] is process-lifetime state, matching kombu's
//! per-channel declaration cache: the declaration commands are emitted only on
//! the first publish after startup, while every publish emits the `LPUSH`.
//!
//! The generated message carries runtime identities the recording cannot
//! supply (the task id, the per-process reply identity, the worker origin, the
//! per-message delivery tag). They are produced here exactly as the source
//! produces them; replay policy must describe them as generated values.

use std::collections::BTreeSet;
use std::sync::Mutex;

use base64::Engine as _;
use brz_redis::{Cmd, Redis, RedisError, RedisPipe, RedisResult, cmd};
use serde_json::{Map, Value};

/// `kombu.transport.redis.PRIORITY_STEPS`.
const PRIORITY_STEPS: [u8; 4] = [0, 3, 6, 9];
/// `kombu.transport.redis.Channel.sep`.
const KOMBU_SEP: &str = "\u{6}\u{16}";
/// `kombu.transport.redis.Channel.keyprefix_queue`.
const KOMBU_BINDING_PREFIX: &str = "_kombu.binding.";
/// `celery.backends.redis.RedisBackend._get_key_for_task`.
const RESULT_CHANNEL_PREFIX: &str = "celery-task-meta-";
/// RFC 4122 OID namespace (`uuid.NAMESPACE_OID`), used by kombu `generate_oid`.
const NAMESPACE_OID: [u8; 16] = [
    0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
];

/// One Celery task to publish.
pub(crate) struct CeleryTask<'a> {
    /// `headers.task`, e.g. `app.tasks.knowledge_tasks.index_document`.
    pub(crate) task_name: &'a str,
    /// The broker queue (`headers.properties.delivery_info.routing_key`).
    pub(crate) queue: &'a str,
    /// The client-side generated task id (`headers.id` / `correlation_id`).
    pub(crate) task_id: &'a str,
    /// `delay(**payload)` keyword arguments, in request-payload order.
    pub(crate) kwargs: &'a Map<String, Value>,
    /// Compatibility publisher deadline for consumers outside the Rust runtime.
    pub(crate) expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Process-lifetime Celery publisher.
///
/// `subscriber` is the source's dedicated result-backend client
/// (`celery/backends/redis.py:Start` calls `backend.client.pubsub()`); keeping
/// it separate means `SUBSCRIBE`/`UNSUBSCRIBE` never share the producer
/// session. `declarations` is kombu's per-channel declaration cache.
pub struct CeleryBroker {
    origin: String,
    reply_to: String,
    subscriber: Option<brz_redis::RedisService>,
    declarations: Mutex<BTreeSet<String>>,
}

impl CeleryBroker {
    /// Builds the process-lifetime publisher.
    ///
    /// `subscriber` is `None` when Redis is unavailable at startup; dispatch
    /// then fails like the source's unreachable broker.
    pub(crate) fn new(subscriber: Option<brz_redis::RedisService>) -> Self {
        Self {
            origin: process_origin(),
            reply_to: process_reply_to(),
            subscriber,
            declarations: Mutex::new(BTreeSet::new()),
        }
    }

    /// Publishes one task: registers the result channel, then declares the
    /// queue on the first publish and `LPUSH`es the protocol-v2 message.
    pub(crate) async fn dispatch<R>(&self, publisher: &R, task: &CeleryTask<'_>) -> RedisResult<()>
    where
        R: Redis,
    {
        let Some(subscriber) = self.subscriber.as_ref() else {
            return Err(RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "the Celery result subscriber is unavailable",
            ));
        };
        let channel = format!("{RESULT_CHANNEL_PREFIX}{}", task.task_id);
        if let Err(error) = run_commands(subscriber, subscription_commands(&channel)).await {
            // The result consumer is bookkeeping for a wait this port does not
            // perform. A server rejection of the channel confirmation must not
            // suppress the publish; real transport failures still do.
            if !is_rejected_command(&error) {
                return Err(error);
            }
            tracing::warn!(
                %error,
                channel = %channel,
                "the Celery result channel was rejected; continuing the publish"
            );
        }
        self.publish(publisher, task).await
    }

    /// `channel.basic_publish` after `maybe_declare`: the first publish in the
    /// process declares, every publish pushes the message.
    async fn publish<R>(&self, publisher: &R, task: &CeleryTask<'_>) -> RedisResult<()>
    where
        R: Redis,
    {
        let message = self.message_json(task, &uuid4());
        let declare = self.take_declaration(task.queue);
        let mut commands = if declare {
            declaration_commands(task.queue)
        } else {
            Vec::with_capacity(1)
        };
        let mut push = cmd("LPUSH");
        push.arg(task.queue).arg(message);
        commands.push(push);
        run_commands(publisher, commands).await
    }

    /// kombu's `_declarations` cache: true only for the first publish of a
    /// queue after process startup.
    fn take_declaration(&self, queue: &str) -> bool {
        let mut declared = self
            .declarations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        declared.insert(queue.to_owned())
    }

    /// Renders the protocol-v2 envelope exactly like `kombu.utils.json.dumps`
    /// applied to `as_task_v2`'s message dict.
    fn message_json(&self, task: &CeleryTask<'_>, delivery_tag: &str) -> String {
        let kwargs_value = Value::Object(task.kwargs.clone());
        let kwargsrepr = saferepr(&kwargs_value);
        let mut embed = Map::new();
        for key in ["callbacks", "errbacks", "chain", "chord"] {
            embed.insert(key.to_owned(), Value::Null);
        }
        let body = crate::json_compat::python_json_value(&Value::Array(vec![
            Value::Array(Vec::new()),
            kwargs_value,
            Value::Object(embed),
        ]));
        let body = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());

        let timelimit = vec![Value::Null, Value::Null];
        let mut headers = Map::new();
        headers.insert("lang".to_owned(), Value::from("py"));
        headers.insert("task".to_owned(), Value::from(task.task_name));
        headers.insert("id".to_owned(), Value::from(task.task_id));
        headers.insert("shadow".to_owned(), Value::Null);
        headers.insert("eta".to_owned(), Value::Null);
        headers.insert(
            "expires".to_owned(),
            task.expires_at
                .map(|at| Value::from(at.to_rfc3339()))
                .unwrap_or(Value::Null),
        );
        headers.insert("group".to_owned(), Value::Null);
        headers.insert("group_index".to_owned(), Value::Null);
        headers.insert("retries".to_owned(), Value::from(0));
        headers.insert("timelimit".to_owned(), Value::Array(timelimit));
        headers.insert("root_id".to_owned(), Value::from(task.task_id));
        headers.insert("parent_id".to_owned(), Value::Null);
        headers.insert("argsrepr".to_owned(), Value::from("()"));
        headers.insert("kwargsrepr".to_owned(), Value::from(kwargsrepr));
        headers.insert("origin".to_owned(), Value::from(self.origin.as_str()));
        headers.insert("ignore_result".to_owned(), Value::from(false));
        headers.insert("replaced_task_nesting".to_owned(), Value::from(0));
        headers.insert("stamped_headers".to_owned(), Value::Null);
        headers.insert("stamps".to_owned(), Value::Object(Map::new()));

        let mut delivery_info = Map::new();
        delivery_info.insert("exchange".to_owned(), Value::from(""));
        delivery_info.insert("routing_key".to_owned(), Value::from(task.queue));
        let mut properties = Map::new();
        properties.insert("correlation_id".to_owned(), Value::from(task.task_id));
        properties.insert("reply_to".to_owned(), Value::from(self.reply_to.as_str()));
        properties.insert("delivery_mode".to_owned(), Value::from(2));
        properties.insert("delivery_info".to_owned(), Value::Object(delivery_info));
        properties.insert("priority".to_owned(), Value::from(0));
        properties.insert("body_encoding".to_owned(), Value::from("base64"));
        properties.insert("delivery_tag".to_owned(), Value::from(delivery_tag));

        let mut message = Map::new();
        message.insert("body".to_owned(), Value::from(body));
        message.insert("content-encoding".to_owned(), Value::from("utf-8"));
        message.insert("content-type".to_owned(), Value::from("application/json"));
        message.insert("headers".to_owned(), Value::Object(headers));
        message.insert("properties".to_owned(), Value::Object(properties));
        crate::json_compat::python_json_value(&Value::Object(message))
    }
}

/// `celery/backends/redis.py:ResultConsumer`: the confirmation exchanges for
/// the result channel the handler subscribes to before publishing.
fn subscription_commands(channel: &str) -> Vec<Cmd> {
    let mut subscribe = cmd("SUBSCRIBE");
    subscribe.arg(channel);
    let mut unsubscribe = cmd("UNSUBSCRIBE");
    unsubscribe.arg(channel);
    vec![subscribe, unsubscribe]
}

/// `kombu.transport.redis.Channel.queue_declare` + `_queue_bind`:
/// `_size` (a transaction over the priority queues) and the binding-set `SADD`.
fn declaration_commands(queue: &str) -> Vec<Cmd> {
    let mut commands = Vec::with_capacity(7);
    commands.push(cmd("MULTI"));
    for priority in PRIORITY_STEPS {
        let mut llen = cmd("LLEN");
        llen.arg(priority_key(queue, priority));
        commands.push(llen);
    }
    commands.push(cmd("EXEC"));
    let mut bind = cmd("SADD");
    bind.arg(format!("{KOMBU_BINDING_PREFIX}{queue}"))
        .arg(format!("{queue}{KOMBU_SEP}{KOMBU_SEP}{queue}"));
    commands.push(bind);
    commands
}

/// `kombu.transport.redis.Channel._q_for_pri`.
fn priority_key(queue: &str, priority: u8) -> String {
    if priority == 0 {
        queue.to_owned()
    } else {
        format!("{queue}{KOMBU_SEP}{priority}")
    }
}

/// Executes one finite ordered batch on one logical connection.
///
/// Every reply is drained even after a server error, so a rejected command
/// cannot leave an unread confirmation on the session and desynchronize the
/// next request. The first error is returned after the batch is drained.
async fn run_commands<R>(redis: &R, commands: Vec<Cmd>) -> RedisResult<()>
where
    R: Redis,
{
    let mut pipe = RedisPipe::with_capacity(commands.len());
    for command in commands {
        pipe.command(command)?;
    }
    let mut responses = redis.pipe(pipe).await?;
    let mut first_error = None;
    while !responses.is_empty() {
        if let Err(error) = responses.take_value::<brz_redis::Value>().await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// A server error reply (as opposed to an unavailable, timed-out, or otherwise
/// transport-failed broker).
pub(crate) fn is_rejected_command(error: &RedisError) -> bool {
    error.kind() == brz_redis::ErrorKind::ResponseError
}

/// `celery.utils.nodenames.anon_nodename()`: `gen<pid>@<hostname>`.
fn process_origin() -> String {
    let hostname = std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_owned());
    format!("gen{}@{}", std::process::id(), hostname)
}

/// `celery/app/base.py:App.thread_oid` via `kombu.common.generate_oid`: a
/// UUIDv3 that is stable for this process.
fn process_reply_to() -> String {
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random).expect("OS randomness is available");
    let instance = u64::from_le_bytes(random);
    let name = format!(
        "{:x}-{:x}-{:x}-{:x}",
        0u64,
        std::process::id(),
        1u64,
        instance
    );
    uuid3_oid(&name)
}

/// `celery` task ids and `kombu` delivery tags are fresh UUIDv4 strings.
fn uuid4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(&bytes)
}

/// `kombu.common.generate_oid`'s `uuid3(NAMESPACE_OID, name)`.
fn uuid3_oid(name: &str) -> String {
    use md5::{Digest as _, Md5};
    let mut hasher = Md5::new();
    hasher.update(NAMESPACE_OID);
    hasher.update(name.as_bytes());
    let mut bytes: [u8; 16] = hasher.finalize().into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(&bytes)
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

/// `celery.utils.saferepr.saferepr` for the JSON payloads this module carries.
///
/// Celery's streaming implementation quotes strings with single quotes and
/// escapes only `'`; it deliberately leaves backslashes and control characters
/// unescaped (`_format_chars`). The 1024-character truncation budget is not
/// reproduced.
fn saferepr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\'', "\\'")),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(saferepr).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("'{}': {}", key.replace('\'', "\\'"), saferepr(value)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_broker() -> CeleryBroker {
        CeleryBroker {
            origin: "gen53@example-host".to_owned(),
            reply_to: "22222222-2222-3222-8222-222222222222".to_owned(),
            subscriber: None,
            declarations: Mutex::new(BTreeSet::new()),
        }
    }

    fn test_task<'a>(kwargs: &'a Map<String, Value>) -> CeleryTask<'a> {
        CeleryTask {
            task_name: "app.tasks.knowledge_tasks.index_document",
            queue: "wegent_online",
            task_id: "11111111-1111-4111-8111-111111111111",
            kwargs,
            expires_at: None,
        }
    }

    fn test_kwargs() -> Map<String, Value> {
        json!({
            "knowledge_base_id": "201",
            "attachment_id": 301,
            "document_id": 401,
            "index_generation": 1,
            "splitter_config_dict": {
                "chunk_strategy": "flat",
                "flat_config": {
                    "chunk_size": 1024,
                    "chunk_overlap": 50,
                    "separator": "\n\n"
                }
            },
            "trigger_summary": true
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn published_message_matches_the_celery_protocol_v2_envelope() {
        let broker = test_broker();
        let kwargs = test_kwargs();
        let message =
            broker.message_json(&test_task(&kwargs), "33333333-3333-4333-8333-333333333333");
        let expected = r#"{"body": "W1tdLCB7Imtub3dsZWRnZV9iYXNlX2lkIjogIjIwMSIsICJhdHRhY2htZW50X2lkIjogMzAxLCAiZG9jdW1lbnRfaWQiOiA0MDEsICJpbmRleF9nZW5lcmF0aW9uIjogMSwgInNwbGl0dGVyX2NvbmZpZ19kaWN0IjogeyJjaHVua19zdHJhdGVneSI6ICJmbGF0IiwgImZsYXRfY29uZmlnIjogeyJjaHVua19zaXplIjogMTAyNCwgImNodW5rX292ZXJsYXAiOiA1MCwgInNlcGFyYXRvciI6ICJcblxuIn19LCAidHJpZ2dlcl9zdW1tYXJ5IjogdHJ1ZX0sIHsiY2FsbGJhY2tzIjogbnVsbCwgImVycmJhY2tzIjogbnVsbCwgImNoYWluIjogbnVsbCwgImNob3JkIjogbnVsbH1d", "content-encoding": "utf-8", "content-type": "application/json", "headers": {"lang": "py", "task": "app.tasks.knowledge_tasks.index_document", "id": "11111111-1111-4111-8111-111111111111", "shadow": null, "eta": null, "expires": null, "group": null, "group_index": null, "retries": 0, "timelimit": [null, null], "root_id": "11111111-1111-4111-8111-111111111111", "parent_id": null, "argsrepr": "()", "kwargsrepr": "{'knowledge_base_id': '201', 'attachment_id': 301, 'document_id': 401, 'index_generation': 1, 'splitter_config_dict': {'chunk_strategy': 'flat', 'flat_config': {'chunk_size': 1024, 'chunk_overlap': 50, 'separator': '\n\n'}}, 'trigger_summary': True}", "origin": "gen53@example-host", "ignore_result": false, "replaced_task_nesting": 0, "stamped_headers": null, "stamps": {}}, "properties": {"correlation_id": "11111111-1111-4111-8111-111111111111", "reply_to": "22222222-2222-3222-8222-222222222222", "delivery_mode": 2, "delivery_info": {"exchange": "", "routing_key": "wegent_online"}, "priority": 0, "body_encoding": "base64", "delivery_tag": "33333333-3333-4333-8333-333333333333"}}"#;
        assert_eq!(message, expected);
    }

    #[test]
    fn first_publish_declares_the_kombu_queue_and_priority_keys() {
        let commands = declaration_commands("wegent_online");
        let args = |index: usize| -> Vec<String> {
            let command = &commands[index];
            (0..command.arg_count())
                .map(|position| {
                    String::from_utf8(command.arg_at(position).unwrap().to_vec()).unwrap()
                })
                .collect()
        };
        assert_eq!(commands.len(), 7);
        assert_eq!(args(0), ["MULTI"]);
        assert_eq!(args(1), ["LLEN", "wegent_online"]);
        assert_eq!(args(2), ["LLEN", "wegent_online\u{6}\u{16}3"]);
        assert_eq!(args(3), ["LLEN", "wegent_online\u{6}\u{16}6"]);
        assert_eq!(args(4), ["LLEN", "wegent_online\u{6}\u{16}9"]);
        assert_eq!(args(5), ["EXEC"]);
        assert_eq!(
            args(6),
            [
                "SADD",
                "_kombu.binding.wegent_online",
                "wegent_online\u{6}\u{16}\u{6}\u{16}wegent_online"
            ]
        );
    }

    #[test]
    fn the_result_channel_is_subscribed_and_released() {
        let commands = subscription_commands("celery-task-meta-abc");
        let args = |index: usize| -> Vec<String> {
            let command = &commands[index];
            (0..command.arg_count())
                .map(|position| {
                    String::from_utf8(command.arg_at(position).unwrap().to_vec()).unwrap()
                })
                .collect()
        };
        assert_eq!(args(0), ["SUBSCRIBE", "celery-task-meta-abc"]);
        assert_eq!(args(1), ["UNSUBSCRIBE", "celery-task-meta-abc"]);
    }

    #[test]
    fn the_declaration_is_taken_once_per_process() {
        let broker = test_broker();
        assert!(broker.take_declaration("wegent_online"));
        assert!(!broker.take_declaration("wegent_online"));
        assert!(broker.take_declaration("another_queue"));
    }

    #[test]
    fn only_server_rejections_are_classified_as_rejected_commands() {
        let rejected = RedisError::new(
            brz_redis::ErrorKind::ResponseError,
            "the broker rejected the command",
        );
        assert!(is_rejected_command(&rejected));

        for kind in [
            brz_redis::ErrorKind::Io,
            brz_redis::ErrorKind::NoConnection,
            brz_redis::ErrorKind::Timeout,
            brz_redis::ErrorKind::Overloaded,
        ] {
            assert!(!is_rejected_command(&RedisError::new(
                kind,
                "the broker is unavailable"
            )));
        }
    }

    #[test]
    fn saferepr_matches_celery_formatting() {
        assert_eq!(
            saferepr(&json!({"a": 1, "b": [true, null, "x'y"]})),
            "{'a': 1, 'b': [True, None, 'x\\'y']}"
        );
        // Celery's `_format_chars` escapes only the quote character; a
        // newline stays literal in `kwargsrepr`.
        assert_eq!(saferepr(&json!("a\nb")), "'a\nb'");
        assert_eq!(saferepr(&json!("a\\b")), "'a\\b'");
    }

    #[test]
    fn generated_identities_have_the_source_shapes() {
        let task_id = uuid4();
        assert_eq!(task_id.len(), 36);
        assert_eq!(&task_id[14..15], "4");
        assert!(matches!(&task_id[19..20], "8" | "9" | "a" | "b"));

        let reply_to = process_reply_to();
        assert_eq!(reply_to.len(), 36);
        assert_eq!(&reply_to[14..15], "3");
        assert!(matches!(&reply_to[19..20], "8" | "9" | "a" | "b"));

        assert!(process_origin().starts_with(&format!("gen{}@", std::process::id())));
    }
}
