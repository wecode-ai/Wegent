// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/pet/event_handlers.py` + `app/services/pet/manager.py`.
//!
//! A completed task grants the owner one chat of experience: the Pet Kind row
//! is read (and created when absent), its spec advanced, and the Socket.IO
//! `pet:experience_gained` frame published to the owner's room.
use brz_mysql::{Json, Mysql, MysqlRow};
use brz_redis::Redis;
use serde_json::{Map, Value, json};

use super::{local_datetime, now_local};
use crate::internal_callback::py_json::python_dumps;

use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;
use crate::internal_callback::socketio::publish_emit_in_room;

/// `EXP_PER_CHAT`.
const EXP_PER_CHAT: i64 = 1;
/// `STAGE_THRESHOLDS`.
const STAGE_THRESHOLDS: [(i64, i64); 3] = [(1, 0), (2, 1000), (3, 5000)];

/// `handle_task_completed_for_pet`.
pub(crate) async fn handle_task_completed_for_pet<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    if event.status != "COMPLETED" {
        return;
    }
    let user_id = event.user_id;
    let (pet_id, mut resource) = match load_pet(ctx, user_id).await {
        Some(pet) => pet,
        None => match create_pet(ctx, user_id).await {
            Some(pet) => pet,
            None => return,
        },
    };

    let Some(Value::Object(spec)) = resource.get("spec").cloned() else {
        return;
    };
    let mut spec = spec;
    let today = now_local().date();
    let today_text = today.format("%Y-%m-%d").to_string();

    // `_update_streak`
    let last_active = spec
        .get("lastActiveDate")
        .and_then(Value::as_str)
        .and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
    let current_streak = spec
        .get("currentStreak")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let (new_streak, is_new_day) = match last_active {
        None => (1, true),
        Some(last) => match (today - last).num_days() {
            0 => (current_streak, false),
            1 => (current_streak + 1, true),
            _ => (1, true),
        },
    };
    if is_new_day {
        spec.insert("currentStreak".into(), json!(new_streak));
        spec.insert("lastActiveDate".into(), Value::String(today_text));
        let longest = spec
            .get("longestStreak")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if new_streak > longest {
            spec.insert("longestStreak".into(), json!(new_streak));
        }
    }

    // `multiplier` and the gained experience.
    let multiplier = streak_multiplier(
        spec.get("currentStreak")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    );
    let exp_gained = (EXP_PER_CHAT as f64 * multiplier).ceil() as i64;
    let total_chats = spec.get("totalChats").and_then(Value::as_i64).unwrap_or(0) + 1;
    let old_stage = spec.get("stage").and_then(Value::as_i64).unwrap_or(1);
    let experience = spec.get("experience").and_then(Value::as_i64).unwrap_or(0) + exp_gained;
    spec.insert("totalChats".into(), json!(total_chats));
    spec.insert("experience".into(), json!(experience));
    spec.insert("stage".into(), json!(calculate_stage(experience)));
    let evolved = spec.get("stage").and_then(Value::as_i64).unwrap_or(1) > old_stage;

    if let Value::Object(root) = &mut resource {
        root.insert("spec".into(), Value::Object(spec.clone()));
    }

    let payload = python_dumps(&resource);
    let sql = sql::update_kind_json();
    let updated_at = local_datetime(now_local());
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(pet_id as u64));
    // A single statement runs on the pooled connection's autocommit; no
    // explicit transaction or COMMIT is needed.
    if let Err(error) = mysql.execute(sql, (payload, updated_at, pet_id)).await {
        tracing::warn!(%error, "pet experience update failed");
        return;
    }
    // `add_chat_experience` (`app/services/pet/manager.py:659-660`):
    // `db.commit()` then `db.refresh(pet)`, whose ORM primary-key load re-reads
    // the row the frame's values were computed from. The refreshed document only
    // reaches the handler's logging, so the frame below keeps the values above.
    let _refreshed: Option<MysqlRow> = mysql
        .fetch_optional(sql::kind_refresh_by_id(), (pet_id,))
        .await
        .ok()
        .flatten();

    // `emit_pet_experience_gained`
    let room = format!("user:{user_id}");
    let payload = json!({
        "amount": exp_gained,
        "total": experience,
        "source": "chat",
        "multiplier": multiplier,
    });
    if let Err(error) =
        publish_emit_in_room(ctx.redis, "pet:experience_gained", &room, payload).await
    {
        tracing::warn!(%error, "pet experience emit failed");
    }

    if evolved {
        // `emit_pet_stage_evolved`: the stage-evolution frame published when a
        // threshold is crossed.
        let new_stage = spec.get("stage").and_then(Value::as_i64).unwrap_or(1);
        let old_stage = new_stage - 1;
        let mut payload = Map::new();
        payload.insert("old_stage".into(), json!(old_stage));
        payload.insert("new_stage".into(), json!(new_stage));
        payload.insert(
            "old_stage_name".into(),
            Value::String(stage_name(old_stage).to_string()),
        );
        payload.insert(
            "new_stage_name".into(),
            Value::String(stage_name(new_stage).to_string()),
        );
        let room = format!("user:{user_id}");
        if let Err(error) = publish_emit_in_room(
            ctx.redis,
            "pet:stage_evolved",
            &room,
            Value::Object(payload),
        )
        .await
        {
            tracing::warn!(%error, "pet stage evolved emit failed");
        }
    }
}

/// `STAGE_NAMES` (`app/schemas/pet.py:218`).
fn stage_name(stage: i64) -> &'static str {
    match stage {
        1 => "baby",
        2 => "growing",
        3 => "mature",
        _ => "unknown",
    }
}

/// `_get_streak_multiplier`.
fn streak_multiplier(current_streak: i64) -> f64 {
    if current_streak >= 30 {
        1.5
    } else if current_streak >= 7 {
        1.2
    } else if current_streak >= 3 {
        1.1
    } else {
        1.0
    }
}

/// `_calculate_stage`.
fn calculate_stage(experience: i64) -> i64 {
    if experience >= STAGE_THRESHOLDS[2].1 {
        3
    } else if experience >= STAGE_THRESHOLDS[1].1 {
        2
    } else {
        1
    }
}

/// `_get_pet_kind`: the owner's Pet Kind row and its CRD document.
async fn load_pet<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    user_id: i64,
) -> Option<(i64, Value)> {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(user_id as u64));
    let row: MysqlRow = mysql
        .fetch_optional(sql::pet_kind(), (user_id,))
        .await
        .ok()
        .flatten()?;
    let id = row.get::<i64>("kinds_id").ok().flatten()?;
    let json = row.get::<Json<Value>>("kinds_json").ok().flatten()?.0;
    Some((id, json))
}

/// `create_pet`: insert the default Pet CRD for an owner, then read it back.
async fn create_pet<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    user_id: i64,
) -> Option<(i64, Value)> {
    let resource = json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Pet",
        "metadata": {"name": "my-pet", "namespace": "default"},
        "spec": {
            "petName": "Wegi",
            "stage": 1,
            "experience": 0,
            "totalChats": 0,
            "currentStreak": 0,
            "longestStreak": 0,
            "lastActiveDate": Value::Null,
            "appearanceTraits": {
                "primary_domain": "general",
                "secondary_domain": Value::Null,
                "color_tone": "gray",
                "accessories": [],
            },
            "svgSeed": svg_seed(),
            "isVisible": true,
        },
        "status": {"state": "Available"},
    });
    let text = python_dumps(&resource);
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(user_id as u64));
    mysql
        .execute(
            sql::insert_pet_kind(),
            (user_id, "Pet", "my-pet", "default", text, true),
        )
        .await
        .ok()?;
    load_pet(ctx, user_id).await
}

/// `_generate_svg_seed`: 32 random bytes as hex.
fn svg_seed() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streak_multipliers_match_the_source_thresholds() {
        assert_eq!(streak_multiplier(0), 1.0);
        assert_eq!(streak_multiplier(2), 1.0);
        assert_eq!(streak_multiplier(3), 1.1);
        assert_eq!(streak_multiplier(7), 1.2);
        assert_eq!(streak_multiplier(30), 1.5);
    }

    #[test]
    fn stages_follow_the_experience_thresholds() {
        assert_eq!(calculate_stage(0), 1);
        assert_eq!(calculate_stage(999), 1);
        assert_eq!(calculate_stage(1000), 2);
        assert_eq!(calculate_stage(4999), 2);
        assert_eq!(calculate_stage(5000), 3);
    }
}
