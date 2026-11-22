//! Reuse raw events already collected for the role under its current source grant.
use super::personal_stand_in::{
    read_personal, stand_in_collection_connection, stand_in_identities,
};
use super::*;
use chrono::TimeZone;

// The manual intake stores the native fields in the message row. Automatic intake
// stores the original envelope before routing. A work summary or action is never evidence.
const RECORDS: &str = "
WITH records(src,msg,activated) AS (
    SELECT json_extract(metadata,'$.source'),metadata,json_extract(metadata,'$.source.enabledAfter') FROM loop_items
    WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1
      AND json_extract(metadata,'$.roleId')=?2
    UNION ALL
    SELECT json_extract(metadata,'$.source'),json_extract(metadata,'$.message'),
           coalesce(json_extract(metadata,'$.roleEnabledAfter'),json_extract(metadata,'$.source.enabledAfter')) FROM loop_items
    WHERE resource_type='stand_in_event' AND json_extract(metadata,'$.userId')=?1
      AND json_extract(metadata,'$.kind')='connection' AND json_extract(metadata,'$.roleScoped')=1
      AND json_array_length(metadata,'$.roleIds')=1 AND json_extract(metadata,'$.roleIds[0]')=?2
), scoped AS (
    SELECT CASE WHEN json_type(msg,'$.objectId')='text' AND json_type(msg,'$.version')='text'
                THEN 'version:'||json_array(json_extract(msg,'$.objectId'),json_extract(msg,'$.version'))
                ELSE 'message:'||json_extract(msg,'$.id') END id,
           json_extract(msg,'$.at') at,json_extract(msg,'$.text') text,
           coalesce(json_extract(msg,'$.truncated'),0) truncated
    FROM records
    WHERE json_extract(src,'$.providerId')=json_extract(?3,'$.providerId')
      AND json_extract(src,'$.profile')=json_extract(?3,'$.profile')
      AND json_extract(src,'$.kind')=json_extract(?3,'$.kind')
      AND json_extract(src,'$.id')=json_extract(?3,'$.id')
      AND activated=json_extract(?3,'$.enabledAfter')
      AND json_extract(src,'$.transport') IS json_extract(?3,'$.transport')
      AND json_extract(src,'$.collectionKey') IS json_extract(?3,'$.collectionKey')
      AND json_extract(src,'$.generation') IS json_extract(?3,'$.generation')
      AND json_extract(src,'$.subscriptionId') IS json_extract(?3,'$.subscriptionId')
      AND json_extract(src,'$.boundary') IS json_extract(?3,'$.boundary')
      AND json_type(msg,'$.id')='text' AND json_type(msg,'$.at')='text' AND json_type(msg,'$.text')='text'
      AND json_extract(msg,'$.id')!='' AND json_extract(msg,'$.text')!=''
)
SELECT id,min(at),min(text) FROM scoped
WHERE id>?4 AND unixepoch(at,CASE WHEN length(at)=19 AND substr(at,11,1)=' ' THEN 'utc' ELSE '+0 seconds' END)
      BETWEEN (?5/1000)-1 AND (?6/1000)+1
GROUP BY id HAVING min(text)=max(text) AND min(at)=max(at) AND max(truncated)=0 ORDER BY id LIMIT 21";

pub fn connection_message_millis(at: &str) -> Option<i64> {
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(at) {
        return Some(time.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|time| chrono::Local.from_local_datetime(&time).single())
        .map(|time| time.timestamp_millis())
}

impl LocalTaskStore {
    pub fn collected_observation_page(
        &self,
        user: i64,
        device: &str,
        role: &str,
        source: &Value,
        since: i64,
        through: i64,
        cursor: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let denied =
            || TaskRuntimeError::Invalid("The role's collection grant is unavailable".into());
        let after = match cursor {
            Some(token) => token
                .strip_prefix("event:")
                .filter(|id| !id.is_empty())
                .ok_or_else(|| TaskRuntimeError::Invalid("Invalid observation cursor".into()))?,
            None => "",
        };
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let settings = read_personal(&tx, user, device)?;
        if !settings["lifecycle"]["status"].is_null()
            || source["collectedObservations"] != true
            || source["id"]
                .as_str()
                .is_none_or(|id| id.is_empty() || id == "*")
        {
            return Err(denied());
        }
        let identity = stand_in_identities(&settings)
            .into_iter()
            .find(|row| {
                row["id"] == role
                    && row["executionDeviceId"] == device
                    && row["enabled"] == true
                    && row["selfLearningEnabled"] == true
            })
            .ok_or_else(denied)?;
        let mut grant = stand_in_collection_connection(&identity, source)
            .filter(|grant| source["enabledAfter"] == grant["enabledAfter"])
            .cloned()
            .ok_or_else(denied)?;
        let since = since.max(
            grant["enabledAfter"]
                .as_str()
                .and_then(connection_message_millis)
                .ok_or_else(denied)?,
        );
        grant["id"] = source["id"].clone();
        let mut query = tx.prepare_cached(RECORDS)?;
        let mut rows = query.query(params![
            user,
            role,
            grant.to_string(),
            after,
            since,
            through
        ])?;
        let mut messages = Vec::new();
        let mut last = String::new();
        for _ in 0..20 {
            let Some(row) = rows.next()? else { break };
            last = row.get(0)?;
            let Some(at) = connection_message_millis(&row.get::<_, String>(1)?)
                .filter(|at| since <= *at && *at < through)
            else {
                continue;
            };
            messages.push(
                json!({"id":last,"at":at,"content":row.get::<_,String>(2)?,"author":"unknown"}),
            );
        }
        let next = rows.next()?.map(|_| format!("event:{last}"));
        Ok(
            json!({"messages":messages,"nextCursor":next,"hasMore":next.is_some(),"reviewCoverage":"partial"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collected_records_are_partial_unattributed_and_bound_to_the_original_role_and_grant() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("events.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"","preferences":"",
            "connections":[{"providerId":"custom/monitor","id":"releases","kind":"stream","profile":"work",
                "name":"Release events","generation":"one","policy":{"automatic":false,"askBeforeAct":true}}]});
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let grant = settings["primary"]["connections"][0].clone();
        let mut source = grant.clone();
        source["collectedObservations"] = json!(true);
        let start = connection_message_millis(grant["enabledAfter"].as_str().unwrap()).unwrap();
        let event_time = |at| {
            chrono::DateTime::from_timestamp_millis(at)
                .unwrap()
                .to_rfc3339()
        };
        let message = |id: &str| {
            json!({"id":id,"at":event_time(start + 1000),
            "text":"A sender reports a delay.","author":"owner","quotedMessageId":"guess"})
        };
        let enqueue = |source: &Value, m: Value, roles: Value, scoped: bool| {
            let identity = json!([source, roles, m]);
            store
                .enqueue_stand_in_event(
                    7,
                    identity,
                    json!({"kind":"connection","roleScoped":scoped,
                "source":source,"roleIds":roles,"message":m}),
                )
                .unwrap();
        };
        let primary = json!(["@primary"]);
        store
            .ingest_stand_in_message(7, "@primary", &grant, &message("manual"), None)
            .unwrap();
        enqueue(&grant, message("manual"), primary.clone(), true);
        enqueue(&grant, message("automatic"), primary.clone(), true);
        for version in ["requested", "finished"] {
            let mut event = message("run-1");
            event["objectId"] = json!("run-1");
            event["version"] = json!(version);
            event["text"] = json!(version);
            enqueue(&grant, event, primary.clone(), true);
        }
        let mut shared = grant.clone();
        shared["enabledAfter"] = json!(event_time(start - 5000));
        store.enqueue_stand_in_event(7,json!("shared"),json!({"kind":"connection","roleScoped":true,
            "source":shared,"roleIds":primary,"roleEnabledAfter":grant["enabledAfter"],"message":message("shared")})).unwrap();
        enqueue(&grant, message("other"), json!(["other"]), true);
        enqueue(&grant, message("legacy"), primary.clone(), false);
        enqueue(&grant, message("multi"), json!(["@primary", "other"]), true);
        for key in [
            "enabledAfter",
            "generation",
            "id",
            "profile",
            "collectionKey",
            "transport",
            "subscriptionId",
            "boundary",
        ] {
            let mut previous = grant.clone();
            previous[key] = json!("different");
            enqueue(&previous, message(key), primary.clone(), true);
        }
        let mut stale = message("stale");
        stale["at"] = json!(event_time(start - 1));
        enqueue(&grant, stale, primary.clone(), true);
        let mut truncated = message("truncated");
        truncated["truncated"] = json!(true);
        enqueue(&grant, truncated, primary.clone(), true);
        let mut ambiguous = message("conflict");
        store
            .ingest_stand_in_message(7, "@primary", &grant, &ambiguous, None)
            .unwrap();
        ambiguous["text"] = json!("Different evidence");
        enqueue(&grant, ambiguous, primary.clone(), true);
        let read = |cursor| {
            store.collected_observation_page(
                7,
                "mac",
                "@primary",
                &source,
                start - 10,
                start + 2000,
                cursor,
            )
        };
        let page = read(None).unwrap();
        assert_eq!(page["reviewCoverage"], "partial");
        let rows = page["messages"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|m| m["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "message:automatic",
                "message:manual",
                "message:shared",
                r#"version:["run-1","finished"]"#,
                r#"version:["run-1","requested"]"#
            ]
        );
        assert!(rows
            .iter()
            .all(|m| m["author"] == "unknown" && m.get("quotedMessageId").is_none()));
        for i in 0..20 {
            enqueue(
                &grant,
                message(&format!("more-{i:02}")),
                primary.clone(),
                true,
            );
        }
        let first = read(None).unwrap();
        assert_eq!(first["hasMore"], true);
        let second = read(first["nextCursor"].as_str()).unwrap();
        assert_eq!(
            first["messages"].as_array().unwrap().len()
                + second["messages"].as_array().unwrap().len(),
            25
        );
        assert_eq!(second["hasMore"], false);
        settings["primary"]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(read(None).is_err());
    }
}
