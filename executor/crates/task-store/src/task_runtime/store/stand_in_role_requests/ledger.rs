//! Each accepted model request has an indexed receipt, independent of the number of turns.
use super::*;
use rusqlite::Transaction;
use sha2::{Digest, Sha256};

fn receipt_key(user: i64, root: &str, intent: &Value, request: &str) -> String {
    format!(
        "stand-in-role-turn-{:x}",
        Sha256::digest(
            json!([
                user,
                root,
                intent["sourceDevice"],
                intent["sourceTaskId"],
                request
            ])
            .to_string()
        )
    )
}

fn fingerprint(intent: &Value, followup: bool, legacy: bool) -> String {
    let mut dependencies: Vec<_> = intent["dependsOn"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    dependencies.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let message = if legacy {
        &intent["message"]
    } else {
        intent.get("requestBrief").unwrap_or(&intent["message"])
    };
    let values = json!([
        followup,
        intent["roleId"],
        intent["targetDevice"],
        intent["sourceRoute"],
        intent["backendUrl"],
        (!followup).then_some(&intent["title"]),
        message,
        dependencies
    ]);
    format!("{:x}", Sha256::digest(values.to_string()))
}

fn request_id(intent: &Value, followup: bool) -> Option<&str> {
    intent[if followup {
        "followupRequestId"
    } else {
        "requestId"
    }]
    .as_str()
}

pub(super) fn record(
    tx: &Transaction<'_>,
    id: &str,
    row: &Value,
    intent: &Value,
    followup: bool,
    legacy: bool,
) -> Result<(), TaskRuntimeError> {
    let Some(request) = request_id(intent, followup) else {
        return Ok(());
    };
    let key = receipt_key(
        row["userId"].as_i64().unwrap(),
        row["root"].as_str().unwrap(),
        intent,
        request,
    );
    let receipt = json!({"fingerprint":fingerprint(intent, followup, legacy),
        "legacyEffective":legacy, "attempt":if followup {row["attempt"].as_u64().unwrap_or(0)} else {0}});
    let inserted = tx.execute(
        "INSERT INTO loop_items(id,resource_type,parent_id,metadata,created_at,updated_at)
         VALUES (?1,'stand_in_role_turn',?2,?3,?4,?4) ON CONFLICT(id) DO NOTHING",
        params![key, id, receipt.to_string(), now()],
    )?;
    if inserted == 0 && !legacy {
        return Err(TaskRuntimeError::VersionConflict);
    }
    Ok(())
}

pub(super) fn replayed(
    tx: &Transaction<'_>,
    rows: &HashMap<String, Value>,
    id: &str,
    user: i64,
    root: &str,
    intent: &Value,
    followup: bool,
) -> Result<bool, TaskRuntimeError> {
    let Some(request) = request_id(intent, followup) else {
        return Ok(false);
    };
    let key = receipt_key(user, root, intent, request);
    let recorded: Option<(String, String, bool)> = tx.query_row(
        "SELECT parent_id,json_extract(metadata,'$.fingerprint'),json_extract(metadata,'$.legacyEffective')
         FROM loop_items WHERE id=?1 AND resource_type='stand_in_role_turn'",
        [key], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    if let Some((branch, saved, legacy)) = recorded {
        return if branch == id && saved == fingerprint(intent, followup, legacy) {
            Ok(true)
        } else {
            Err(TaskRuntimeError::VersionConflict)
        };
    }
    // Older installations have a creation intent but no receipt. Its first update
    // records that original fingerprint before changing the message or dependencies.
    for (branch, row) in rows {
        let saved = &row["intent"];
        if saved["sourceDevice"] == intent["sourceDevice"]
            && saved["sourceTaskId"] == intent["sourceTaskId"]
            && saved["requestId"] == request
        {
            return if branch == id
                && !followup
                && fingerprint(saved, false, true) == fingerprint(intent, false, true)
            {
                Ok(true)
            } else {
                Err(TaskRuntimeError::VersionConflict)
            };
        }
    }
    Ok(false)
}

/// Bind an accepted follow-up to the message that submitted it, preserving the
/// original fingerprint and attempt even when replaying a historical turn.
pub(super) fn bind_followup_to_request(
    tx: &Transaction<'_>,
    id: &str,
    user: i64,
    branch_root: &str,
    request_root: &str,
    intent: &Value,
) -> Result<(), TaskRuntimeError> {
    let request = request_id(intent, true).ok_or(TaskRuntimeError::VersionConflict)?;
    let source = receipt_key(user, branch_root, intent, request);
    let target = receipt_key(user, request_root, intent, request);
    let count = tx.execute(
        "INSERT INTO loop_items(id,resource_type,parent_id,metadata,created_at,updated_at)
         SELECT ?1,resource_type,parent_id,metadata,?2,?2 FROM loop_items
         WHERE id=?3 AND resource_type='stand_in_role_turn' AND parent_id=?4",
        params![target, now(), source, id],
    )?;
    if count != 1 {
        return Err(TaskRuntimeError::VersionConflict);
    }
    Ok(())
}
