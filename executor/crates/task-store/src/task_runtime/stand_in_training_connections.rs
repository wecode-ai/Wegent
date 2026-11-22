//! Resolve previously observed concrete subscriptions and successful attributed replies.
use super::stand_in_inbox::stand_in_record_key;
use super::*;

impl LocalTaskStore {
    /// Project only role/resource metadata; undispatched events and manually handled messages count alike.
    pub fn observed_training_resources(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut query = connection.prepare_cached(
            "WITH observations(role,source,at,epoch) AS (
               SELECT value,json_extract(metadata,'$.source'),json_extract(metadata,'$.message.at'),
                      coalesce(json_extract(metadata,'$.roleEnabledAfter'),json_extract(metadata,'$.source.enabledAfter'))
               FROM loop_items,json_each(metadata,'$.roleIds') WHERE resource_type='stand_in_event'
               AND json_extract(metadata,'$.kind')='connection' AND json_extract(metadata,'$.userId')=?1
               AND json_extract(metadata,'$.roleScoped')=1 AND json_array_length(metadata,'$.roleIds')=1
               UNION ALL
               SELECT json_extract(metadata,'$.roleId'),json_extract(metadata,'$.source'),json_extract(metadata,'$.at'),
                      json_extract(metadata,'$.source.enabledAfter')
               FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1)
             SELECT role,COALESCE(json_extract(source,'$.providerId'),?2),json_extract(source,'$.profile'),
                    json_extract(source,'$.kind'),json_extract(source,'$.id'),json_extract(source,'$.collectionKey'),
                    json_extract(source,'$.transport'),epoch,MAX(at)
             FROM observations WHERE at IS NOT NULL AND json_type(source,'$.id')='text'
               AND json_type(source,'$.profile')='text' AND json_type(source,'$.kind')='text'
             GROUP BY 1,2,3,4,5,6,7,8",
        )?;
        let rows = query.query_map(
            params![user, super::personal_stand_in::DINGTALK_PROVIDER],
            |row| {
                Ok(
                    json!({"roleId":row.get::<_,String>(0)?, "providerId":row.get::<_,String>(1)?,
                "profile":row.get::<_,String>(2)?, "kind":row.get::<_,String>(3)?, "id":row.get::<_,String>(4)?,
                "collectionKey":row.get::<_,Option<String>>(5)?, "transport":row.get::<_,Option<String>>(6)?,
                "enabledAfter":row.get::<_,Option<String>>(7)?, "at":row.get::<_,String>(8)?}),
                )
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Source grants and role ownership are checked in the same transaction as the accepted receipt.
    pub fn record_training_reply(
        &self,
        user: i64,
        device: &str,
        role_device: &str,
        role: &str,
        source: &Value,
        request: &str,
        text: &str,
        native_id: Option<&str>,
        versions: Option<(&str, &str)>,
    ) -> Result<(), TaskRuntimeError> {
        if identity_task(source).is_some() || !source["enabledAfter"].is_string() {
            return Ok(());
        }
        let source = delivery_source(source);
        self.record_delivery(
            user,
            device,
            role_device,
            role,
            &source,
            request,
            text,
            native_id,
            chrono::Utc::now().timestamp_millis(),
            versions,
        )
    }

    /// Called by the owner- and identity-bound transcript handler after actual assistant output.
    pub fn record_identity_training_reply(
        &self,
        user: i64,
        device: &str,
        role_device: &str,
        role: &str,
        task: &str,
        request: &str,
        item: &str,
        at: i64,
        versions: Option<(&str, &str)>,
    ) -> Result<(), TaskRuntimeError> {
        if [task, request, item].contains(&"") || at <= 0 {
            return Ok(());
        }
        self.record_delivery(
            user,
            device,
            role_device,
            role,
            &identity_source(task),
            request,
            "",
            Some(item),
            at,
            versions,
        )
    }

    fn record_delivery(
        &self,
        user: i64,
        device: &str,
        role_device: &str,
        role: &str,
        source: &Value,
        request: &str,
        text: &str,
        native_id: Option<&str>,
        at: i64,
        versions: Option<(&str, &str)>,
    ) -> Result<(), TaskRuntimeError> {
        use super::personal_stand_in::{
            read_personal, stand_in_identities, training_source_granted,
        };
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let settings = read_personal(&tx, user, device)?;
        let roles = stand_in_identities(&settings);
        let Some(active) = roles.iter().find(|id| {
            id["id"] == role
                && id["executionDeviceId"] == role_device
                && id["enabled"] == true
                && id["selfLearningEnabled"] == true
        }) else {
            return Ok(());
        };
        if !settings["lifecycle"]["status"].is_null()
            || (identity_task(source).is_none() && !training_source_granted(active, source))
        {
            return Ok(());
        }
        if source["providerId"] == super::personal_stand_in::ISSUE_COMMENTS_PROVIDER
            && source["profile"] == "local"
            && !super::stand_in_memories::local_issue_visible(&tx, active, source)?
        {
            return Ok(());
        }
        let native_id = native_id.filter(|id| !id.trim().is_empty());
        let key = match (identity_task(source), native_id) {
            (Some(task), Some(item)) => identity_item_key(user, task, request, item),
            (_, Some(item)) => delivery_key(user, source, item),
            (_, None) => unidentified_delivery_key(user, source, request, text),
        };
        let (ghost, memory) = versions.unzip();
        let mut metadata = json!({"userId":user,"deviceId":device,"roleId":role,"source":source,"requestId":request,
            "nativeMessageId":native_id,"sentAt":at,"ghostVersion":ghost,"memoryVersion":memory});
        if source["providerId"] == super::personal_stand_in::EMAIL_PROVIDER {
            metadata["bodyDigest"] = json!(email_body_digest(text));
        }
        // An idempotent retry preserves the first receipt's versions, timestamp and evidence.
        tx.execute("INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?4)
             ON CONFLICT(id) DO UPDATE SET metadata=json_set(metadata,'$.ambiguous',json('true')),updated_at=excluded.updated_at
             WHERE json_extract(metadata,'$.roleId') IS NOT json_extract(excluded.metadata,'$.roleId')
                OR json_extract(metadata,'$.deviceId') IS NOT json_extract(excluded.metadata,'$.deviceId')
                OR json_extract(metadata,'$.source') IS NOT json_extract(excluded.metadata,'$.source')
                OR json_extract(metadata,'$.requestId') IS NOT json_extract(excluded.metadata,'$.requestId')
                OR json_extract(metadata,'$.bodyDigest') IS NOT json_extract(excluded.metadata,'$.bodyDigest')",
            params![key,DELIVERY,metadata.to_string(),now()])?;
        tx.commit()?;
        Ok(())
    }

    pub fn training_reply_request_id(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        native_id: &str,
    ) -> Result<Option<String>, TaskRuntimeError> {
        let source = delivery_source(source);
        Ok(receipt(
            &*self.connection()?,
            &delivery_key(user, &source, native_id),
        )?
        .filter(|row| {
            row["userId"] == user
                && row["roleId"] == role
                && row["source"] == source
                && row["ambiguous"] != true
                && row["nativeMessageId"] == native_id
        })
        .and_then(|row| {
            row["requestId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        }))
    }

    pub fn training_reply_matches(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        native_id: &str,
        at: i64,
        quoted: &str,
        text: &str,
        thread: Option<&str>,
    ) -> Result<bool, TaskRuntimeError> {
        let source = delivery_source(source);
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let key = delivery_key(user, &source, native_id);
        if let Some(row) = receipt(&tx, &key)? {
            let valid_content = source["providerId"] != super::personal_stand_in::EMAIL_PROVIDER
                || (!quoted.is_empty() && row["bodyDigest"] == email_body_digest(text));
            let matches = row["roleId"] == role
                && row["userId"] == user
                && row["ambiguous"] != true
                && (quoted.is_empty() || row["requestId"] == quoted)
                && row["source"] == source
                && valid_content;
            let thread = thread.filter(|id| !id.is_empty());
            if matches
                && row["threadId"]
                    .as_str()
                    .zip(thread)
                    .is_some_and(|(old, new)| old != new)
            {
                tx.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.ambiguous',json('true')) WHERE id=?1",[key])?;
                tx.commit()?;
                return Ok(false);
            }
            if matches
                && (row["historySeenAt"].is_null()
                    || (row["threadId"].is_null() && thread.is_some()))
            {
                tx.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.historySeenAt',coalesce(json_extract(metadata,'$.historySeenAt'),?2),'$.threadId',coalesce(json_extract(metadata,'$.threadId'),?3)) WHERE id=?1",params![key,at,thread])?;
                tx.commit()?;
            }
            return Ok(matches);
        }
        // Historical DingTalk acceptances may have only a provider-specific request/body fingerprint.
        if source["providerId"] != super::personal_stand_in::DINGTALK_PROVIDER {
            return Ok(false);
        }
        if let Some(row) = receipt(&tx, &unidentified_delivery_key(user, &source, quoted, text))? {
            return Ok(row["roleId"] == role && row["ambiguous"] != true);
        }
        Ok(get_item_from(
            &tx,
            &legacy_reply_key(user, &source, quoted, text),
            "stand_in_dingtalk_reply_receipt",
        )?
        .is_some_and(|record| {
            record.metadata["roleId"] == role
                && record.metadata["userId"] == user
                && source["enabledAfter"]
                    .as_str()
                    .and_then(|since| chrono::DateTime::parse_from_rfc3339(since).ok())
                    .zip(chrono::DateTime::parse_from_rfc3339(&record.created_at).ok())
                    .is_some_and(|(since, recorded)| recorded >= since)
        }))
    }

    pub fn identity_training_reply_seen(
        &self,
        user: i64,
        role: &str,
        task: &str,
        request: &str,
        item: &str,
        projected: &str,
    ) -> Result<bool, TaskRuntimeError> {
        Ok(receipt(
            &*self.connection()?,
            &identity_item_key(user, task, request, item),
        )?
        .is_some_and(|r| {
            r["roleId"] == role
                && r["ambiguous"] != true
                && r["evidenceMessageId"] == projected
                && r["historySeenAt"].as_i64().is_some_and(|at| at > 0)
        }))
    }

    pub fn observe_identity_training_reply(
        &self,
        user: i64,
        role: &str,
        task: &str,
        request: &str,
        item: &str,
        projected_id: &str,
        observed_at: i64,
    ) -> Result<(), TaskRuntimeError> {
        if [task, request, item, projected_id].contains(&"") || observed_at <= 0 {
            return Ok(());
        }
        let key = identity_item_key(user, task, request, item);
        self.connection()?.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.historySeenAt',?2,'$.evidenceMessageId',?3)
            WHERE id=?1 AND resource_type=?4 AND json_extract(metadata,'$.roleId')=?5 AND json_extract(metadata,'$.requestId')=?6
            AND json_extract(metadata,'$.historySeenAt') IS NULL AND json_extract(metadata,'$.ambiguous') IS NOT 1",
            params![key,observed_at,projected_id,DELIVERY,role,request])?;
        Ok(())
    }
}

pub(super) const DELIVERY: &str = "stand_in_delivery";
pub(super) const LEGACY_DELIVERY: &str = "stand_in_dingtalk_delivery";

fn receipt(tx: &Connection, key: &str) -> Result<Option<Value>, TaskRuntimeError> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type IN (?2,?3)",
            params![key, DELIVERY, LEGACY_DELIVERY],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(|e| TaskRuntimeError::Invalid(e.to_string())))
        .transpose()
}

fn identity_item_key(user: i64, task: &str, request: &str, item: &str) -> String {
    stand_in_record_key(
        "stand-in-identity-delivery",
        &json!([user, task, request, item]),
    )
}

pub(super) fn identity_source(task: &str) -> Value {
    json!({"providerId":"wework.identity","kind":"identity","id":task})
}

pub(super) fn identity_task(source: &Value) -> Option<&str> {
    (source["providerId"] == "wework.identity" && source["kind"] == "identity")
        .then(|| source["id"].as_str())
        .flatten()
}

fn email_body_digest(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    stand_in_record_key(
        "email-body",
        &json!(normalized.strip_suffix('\n').unwrap_or(&normalized)),
    )
}

/// Persist the source identity and subscription epoch, not display data or credentials.
fn delivery_source(source: &Value) -> Value {
    let mut projected = json!({"providerId":super::personal_stand_in::source_provider(source)});
    for field in [
        "profile",
        "kind",
        "id",
        "projectId",
        "transport",
        "enabledAfter",
        "collectionKey",
    ] {
        if let Some(value) = source.get(field) {
            projected[field] = value.clone();
        }
    }
    projected
}

fn delivery_key(user: i64, source: &Value, native_id: &str) -> String {
    if source["providerId"] == super::personal_stand_in::DINGTALK_PROVIDER {
        // Preserve stable keys for accepted messages from before provider-neutral receipts.
        return stand_in_record_key(
            "stand-in-dingtalk-delivery",
            &json!([
                user,
                source["profile"],
                source["kind"],
                source["id"],
                native_id
            ]),
        );
    }
    stand_in_record_key("stand-in-delivery", &json!([user, source, native_id]))
}

fn unidentified_delivery_key(user: i64, source: &Value, request: &str, text: &str) -> String {
    if source["providerId"] == super::personal_stand_in::DINGTALK_PROVIDER {
        return stand_in_record_key(
            "stand-in-unidentified-delivery",
            &json!([
                source["enabledAfter"],
                source["collectionKey"],
                legacy_reply_key(user, source, request, text)
            ]),
        );
    }
    stand_in_record_key(
        "stand-in-unidentified-delivery",
        &json!([user, source, request, text]),
    )
}

fn legacy_reply_key(user: i64, source: &Value, quoted: &str, text: &str) -> String {
    stand_in_record_key(
        "stand-in-dingtalk-reply",
        &json!([
            user,
            source["profile"],
            source["kind"],
            source["id"],
            quoted,
            text
        ]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_learning_never_records_replies_and_enabled_receipts_bind_role_source_target_and_text(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let source = json!({"providerId":super::super::personal_stand_in::DINGTALK_PROVIDER, "profile":"account",
            "kind":"direct","id":"peer","name":"Peer","policy":{"automatic":false,"askBeforeAct":true}});
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] =
            json!({"enabled":true,"prompt":"","preferences":"","connections":[source]});
        let mut saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let source = &saved["primary"]["connections"][0].clone();
        let record = || {
            store
                .record_training_reply(
                    7, "mac", "mac", "@primary", source, "original", "reply", None, None,
                )
                .unwrap()
        };
        let matched = |role, quoted, text| {
            store
                .training_reply_matches(7, role, source, "opaque", 1000, quoted, text, None)
                .unwrap()
        };
        record();
        assert!(!matched("@primary", "original", "reply"));
        saved["primary"]["selfLearningEnabled"] = json!(true);
        store.save_personal_stand_in(7, "mac", saved).unwrap();
        record();
        assert!(matched("@primary", "original", "reply"));
        assert!(!matched("other", "original", "reply"));
        assert!(!matched("@primary", "another", "reply"));
        assert!(!matched("@primary", "original", "rewritten"));
        for versions in [
            ("ghost-before", "memory-before"),
            ("ghost-after", "memory-after"),
        ] {
            store
                .record_training_reply(
                    7,
                    "mac",
                    "mac",
                    "@primary",
                    source,
                    "original",
                    "reply",
                    Some("sent-id"),
                    Some(versions),
                )
                .unwrap();
        }
        let read = || {
            receipt(
                &store.connection().unwrap(),
                &delivery_key(7, source, "sent-id"),
            )
            .unwrap()
            .unwrap()
        };
        assert_eq!(read()["ghostVersion"], "ghost-before");
        assert_eq!(read()["memoryVersion"], "memory-before");
        // A pre-upgrade delivery has the same key, retains its version, and remains attributable.
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET resource_type=?2 WHERE id=?1",
                params![delivery_key(7, source, "sent-id"), LEGACY_DELIVERY],
            )
            .unwrap();
        assert!(read()["historySeenAt"].is_null());
        assert!(!store
            .training_reply_matches(7, "other", source, "sent-id", 999, "original", "reply", None)
            .unwrap());
        assert!(read()["historySeenAt"].is_null());
        assert!(store
            .training_reply_matches(
                7,
                "@primary",
                source,
                "sent-id",
                1000,
                "",
                "rendered mention text",
                None
            )
            .unwrap());
        assert_eq!(read()["historySeenAt"], 1000);
        assert!(store
            .training_reply_matches(
                7, "@primary", source, "sent-id", 1001, "original", "reply", None
            )
            .unwrap());
        assert_eq!(read()["historySeenAt"], 1000);
        let key = legacy_reply_key(7, source, "legacy-request", "legacy-reply");
        store.connection().unwrap().execute(
            "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES(?1,'stand_in_dingtalk_reply_receipt',?2,?3,?3)",
            params![key, json!({"userId":7,"roleId":"@primary"}).to_string(), now()]
        ).unwrap();
        assert!(matched("@primary", "legacy-request", "legacy-reply"));
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET created_at='1970-01-01T00:00:00Z' WHERE id=?1",
                [&key],
            )
            .unwrap();
        assert!(!matched("@primary", "legacy-request", "legacy-reply"));
    }
    #[test]
    fn provider_ids_epochs_and_verified_mail_headers_bound_each_accepted_reply() {
        use super::super::personal_stand_in::EMAIL_PROVIDER;
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("db")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let source = json!({"providerId":EMAIL_PROVIDER,"profile":"account","kind":"inbox","id":"INBOX",
            "name":"Inbox","policy":{"automatic":false,"askBeforeAct":true}});
        let mut second = source.clone();
        second["providerId"] = json!("example/messages");
        settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"","preferences":"",
            "connections":[source,second]});
        let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let sources = saved["primary"]["connections"].as_array().unwrap();
        for (i, source) in sources.iter().enumerate() {
            store
                .record_training_reply(
                    7,
                    "mac",
                    "mac",
                    "@primary",
                    source,
                    "question",
                    "answer",
                    Some("same-id"),
                    Some(("ghost", &i.to_string())),
                )
                .unwrap();
        }
        let email = sources
            .iter()
            .find(|s| s["providerId"] == EMAIL_PROVIDER)
            .unwrap();
        let other = sources
            .iter()
            .find(|s| s["providerId"] != EMAIL_PROVIDER)
            .unwrap();
        let seen = |source, quoted, text| {
            store
                .training_reply_matches(
                    7,
                    "@primary",
                    source,
                    "same-id",
                    1000,
                    quoted,
                    text,
                    Some("thread"),
                )
                .unwrap()
        };
        assert!(!seen(email, "question", "copied header only"));
        assert!(!seen(email, "", "answer"));
        assert!(seen(email, "question", "answer\r\n"));
        assert!(seen(other, "question", "provider rendering"));
        let read = |source: &Value| {
            receipt(
                &store.connection().unwrap(),
                &delivery_key(7, &delivery_source(source), "same-id"),
            )
            .unwrap()
            .unwrap()
        };
        assert_ne!(read(email)["memoryVersion"], read(other)["memoryVersion"]);
        assert_eq!(read(email)["threadId"], "thread");
        let mut rebound = email.clone();
        rebound["enabledAfter"] = json!("2099-01-01T00:00:00Z");
        assert!(!store
            .training_reply_matches(
                7, "@primary", &rebound, "same-id", 1000, "question", "answer", None
            )
            .unwrap());
    }
}
