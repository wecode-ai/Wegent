use super::*;

fn fork_history_subtask(id: i64, message_id: i32, bot_ids: Vec<Option<i64>>) -> SubtaskRow {
    let mut subtask = test_subtask_row("", 0);
    subtask.id = id;
    subtask.message_id = message_id;
    subtask.created_at =
        chrono::NaiveDateTime::default() + chrono::Duration::seconds(i64::from(message_id));
    subtask.bot_ids = Json(JsonProjection {
        value: Some(bot_ids),
    });
    subtask
}

/// `get_task_detail` consumes `resolve_for_task(limit=100)`: the items are
/// sorted by `(message_id, created_at, id)` and only the last 100 are
/// returned. Recorded case 9fba0c4d (task 11132555386195) has 140
/// subtasks; the first 18 reference bot 110593 and the remaining 122
/// reference 110592, so the windowed `all_bot_ids` is `{110592}` and the
/// source probes only `kind:v2:data:Bot:110592`. Without the window the
/// extra 110593 probe leaves the recorded kind-cache lane and the
/// endpoint answers 500 `kind query failed` instead of 404.
#[test]
fn fork_history_window_keeps_the_last_hundred_rows() {
    let mut subtasks: Vec<SubtaskRow> = (1..=140_i64)
        .map(|index| {
            let bot_id = if index <= 18 { 110_593 } else { 110_592 };
            fork_history_subtask(index, index as i32, vec![Some(bot_id)])
        })
        .collect();
    // Feed the window the reverse of the query's `ORDER BY message_id`
    // order so the sort is exercised too.
    subtasks.reverse();

    window_fork_history(&mut subtasks);

    assert_eq!(subtasks.len(), 100);
    assert_eq!(subtasks.first().map(|row| row.message_id), Some(41));
    assert_eq!(subtasks.last().map(|row| row.message_id), Some(140));
    assert!(subtasks.iter().all(|row| {
        row.bot_ids
            .0
            .value
            .as_ref()
            .is_none_or(|ids| !ids.contains(&Some(110_593)))
    }));
}

/// `resolve_for_task` only slices when the collected items exceed the
/// limit, and orders the retained rows by `(message_id, created_at, id)`.
#[test]
fn fork_history_window_keeps_short_lists_in_order() {
    let mut subtasks = vec![
        fork_history_subtask(7, 9, vec![Some(110_593)]),
        fork_history_subtask(5, 4, vec![Some(110_592)]),
    ];

    window_fork_history(&mut subtasks);

    assert_eq!(
        subtasks
            .iter()
            .map(|row| (row.message_id, row.id))
            .collect::<Vec<_>>(),
        vec![(4, 5), (9, 7)]
    );
}

#[test]
fn delete_status_detected_in_json() {
    assert!(json_status_is_delete(
        &serde_json::json!({"status": {"status": "DELETE"}})
    ));
    assert!(!json_status_is_delete(
        &serde_json::json!({"status": {"status": "RUNNING"}})
    ));
}

fn team_record() -> crate::remote_workspace_tree::kinds::KindRecord {
    crate::remote_workspace_tree::kinds::KindRecord {
        id: 19_709,
        user_id: 405,
        kind: "Team".to_owned(),
        name: "AI工具数参助手".to_owned(),
        namespace: "default".to_owned(),
        json: brz_mysql::Json(serde_json::json!({
            "kind": "Team",
            "spec": {"members": [], "collaborationModel": "solo"},
            "metadata": {"name": "AI工具数参助手", "namespace": "default"},
            "apiVersion": "agent.wegent.io/v1"
        })),
        is_active: 1,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
    }
}

/// Step 6's source `if team:` block owns the owner re-read, so a task
/// whose `teamRef` resolved no Team row must issue no extra active-task
/// read. Reading it outside the branch adds a third active-task read per
/// `get_task_detail` round; Replay has no counterpart for it and then
/// cannot serve the round's later `is_member` read, so re-run
/// 20260928020001 answered the recorded tree case fbe38f07 (task
/// 131803956530390) with 500 `database query failed`.
#[tokio::test]
async fn team_detail_skips_the_owner_read_when_no_team_resolves() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = crate::task_store::DefaultTaskStore::new(mysql.clone());
    let erp = crate::erp_provider::NoopErpProvider;
    let erp_context = wegent_access::group_membership::ErpContext {
        erp: &erp,
        redis: None::<&brz_redis::RedisService>,
    };
    let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
        mysql: &mysql,
        redis: None,
    };
    let resolvers = crate::permissions::EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
            .expect("lazy mysql"),
    );

    convert_team_detail(
        &mysql,
        &erp_context,
        &resolvers,
        &kinds,
        &store,
        959,
        131_803_956_530_390,
        None,
    )
    .await
    .expect("the absent team leaves step 6 a no-op");

    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

/// With a resolved Team, step 6 issues the source's owner re-read exactly
/// once; the kind lookups that follow belong to `_convert_to_team_dict`.
#[tokio::test]
async fn team_detail_reads_the_owner_once_when_a_team_resolves() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = crate::task_store::DefaultTaskStore::new(mysql.clone());
    let erp = crate::erp_provider::NoopErpProvider;
    let erp_context = wegent_access::group_membership::ErpContext {
        erp: &erp,
        redis: None::<&brz_redis::RedisService>,
    };
    let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
        mysql: &mysql,
        redis: None,
    };
    let team = team_record();
    let resolvers = crate::permissions::EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
            .expect("lazy mysql"),
    );

    convert_team_detail(
        &mysql,
        &erp_context,
        &resolvers,
        &kinds,
        &store,
        959,
        131_803_956_530_390,
        Some(&team),
    )
    .await
    .expect("the owner read resolves no row and ends the block");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "{queries:?}");
    assert!(
        queries[0].sql.contains("SELECT id, user_id")
            && queries[0].sql.contains("is_active IN (1, 2)"),
        "{}",
        queries[0].sql
    );
}

/// `resolve_task_ref_team`: only a non-null `teamRef.user_id` selects the
/// direct owner query. The recorded tree case (task 135365) carries
/// `"user_id": null`, and the source there runs `_get_team` — the reader
/// chain whose first cache document is
/// `kind:v2:idx:personal:Team:2309:default:wegent-chat`. Resolving such a
/// ref with the public lookup instead reads the public document first and
/// then falls back to a direct SQL read the recording does not contain.
#[test]
fn absent_or_null_team_ref_owner_runs_the_reader_chain() {
    let reference = |user_id: Option<serde_json::Value>| {
        let mut document = serde_json::json!({
            "name": "wegent-chat",
            "namespace": "default",
        });
        if let Some(user_id) = user_id {
            document["user_id"] = user_id;
        }
        serde_json::from_value::<crate::crd::ResourceReference>(document).expect("team ref decodes")
    };

    // Absent and JSON `null` both run `_get_team`.
    assert_eq!(team_ref_owner_id(&reference(None)), None);
    assert_eq!(
        team_ref_owner_id(&reference(Some(serde_json::Value::Null))),
        None
    );
    // An explicit id — including the public `0` — queries by owner.
    assert_eq!(
        team_ref_owner_id(&reference(Some(serde_json::json!(0)))),
        Some(0)
    );
    assert_eq!(
        team_ref_owner_id(&reference(Some(serde_json::json!(2309)))),
        Some(2309)
    );
}
