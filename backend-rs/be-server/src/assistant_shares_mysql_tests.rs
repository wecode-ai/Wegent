//! Exercise real share grants, updates and notification transactions on an isolated schema.
use super::*;
use brz_mysql::MysqlService;
use serde_json::json;

const OWNER: i32 = 7101;
const RECIPIENT: i32 = 7102;
const STRANGER: i32 = 7103;

fn user(id: i32) -> SessionUser {
    let now = chrono::Utc::now().naive_utc();
    SessionUser(crate::auth::UserRow {
        id,
        user_name: format!("share-fixture-{id}"),
        users_password_hash: String::new(),
        email: None,
        git_info: Json(brz_json::OpaqueJson::from(json!({}))),
        is_active: 1,
        role: "user".into(),
        auth_source: "password".into(),
        preferences: String::new(),
        created_at: now,
        updated_at: now,
    })
}

fn assistant(id: &str, prompt: &str) -> Definition {
    serde_json::from_value(json!({
        "kind":"assistant",
        "definition":{"id":id,"name":id,"prompt":prompt}
    }))
    .unwrap()
}

fn team(id: &str, with_reviewer: bool) -> Definition {
    let members = if with_reviewer {
        json!({"data":"Verify figures","review":"Check the report"})
    } else {
        json!({"data":"Verify figures"})
    };
    serde_json::from_value(json!({
        "kind":"team",
        "definition":{"id":id,"name":id,"leadId":"data","members":members}
    }))
    .unwrap()
}

pub(crate) async fn verify(mysql: &MysqlService) -> anyhow::Result<()> {
    for id in [OWNER, RECIPIENT, STRANGER] {
        mysql.execute(
            "INSERT INTO users(id,user_name,password_hash,is_active,`role`,auth_source,preferences) VALUES (?,?,'',TRUE,'user','password','{}')",
            (id,format!("share-fixture-{id}")),
        ).await?;
    }
    let state = crate::app_test_support::app(mysql.clone());
    for (name, allow_copy) in [("weekly", true), ("release", false)] {
        publish_share(
            &state,
            user(OWNER),
            PublishShare {
                recipient_user_id: RECIPIENT,
                allow_copy,
                root: team(name, false),
                assistants: vec![assistant("data", "Original prompt")],
                base_revisions: BTreeMap::new(),
            },
        )
        .await
        .unwrap();
    }

    assert!(
        get_share(&state, user(RECIPIENT), OWNER, "team", "weekly")
            .await
            .is_ok()
    );
    assert_eq!(
        get_share(&state, user(STRANGER), OWNER, "team", "weekly")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    assert_eq!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "team", "weekly", "direct")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    let active = set_direct_use(
        &state,
        user(RECIPIENT),
        OWNER,
        "team",
        "weekly",
        DirectUse { enabled: true },
    )
    .await
    .unwrap();
    assert!(active.direct_enabled);
    assert_eq!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "team", "release", "copy")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    let copied = get_snapshot(&state, user(RECIPIENT), OWNER, "team", "weekly", "copy")
        .await
        .unwrap();
    assert_eq!(
        copied.assistants[0].definition,
        assistant("data", "Original prompt")
    );
    // The Executor outbox sends assistant receipts before team receipts.
    record_copy(
        &state,
        user(RECIPIENT),
        OWNER,
        "assistant",
        "data",
        CopyReceipt { revision: 1 },
    )
    .await
    .unwrap();
    assert_eq!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "assistant", "data", "copy")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    record_copy(
        &state,
        user(RECIPIENT),
        OWNER,
        "team",
        "weekly",
        CopyReceipt { revision: 1 },
    )
    .await
    .unwrap();
    publish_share(
        &state,
        user(OWNER),
        PublishShare {
            recipient_user_id: RECIPIENT,
            allow_copy: true,
            root: team("release", false),
            assistants: vec![assistant("data", "Original prompt")],
            base_revisions: BTreeMap::new(),
        },
    )
    .await
    .unwrap();
    record_copy(
        &state,
        user(RECIPIENT),
        OWNER,
        "team",
        "release",
        CopyReceipt { revision: 1 },
    )
    .await
    .unwrap();

    let derived = list_shares(&state, user(RECIPIENT)).await.unwrap();
    assert_eq!(
        derived
            .received
            .iter()
            .filter(|row| row.source_id == "data" && row.derived)
            .count(),
        1
    );
    assert_eq!(
        get_snapshot(
            &state,
            user(RECIPIENT),
            OWNER,
            "assistant",
            "data",
            "direct"
        )
        .await
        .err()
        .unwrap()
        .status(),
        StatusCode::NOT_FOUND,
    );

    for (revision, prompt) in [(1, "Second prompt"), (2, "Newest prompt")] {
        sync_definition(
            &state,
            user(OWNER),
            SyncDefinition {
                root: assistant("data", prompt),
                expected_revision: revision,
                assistants: Vec::new(),
            },
        )
        .await
        .unwrap();
    }
    let (notices,): (i64,) = mysql.fetch_one(
        "SELECT COUNT(*) FROM wework_notifications WHERE user_id=? AND actor_user_id=? AND kind='assistant_share_update' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.sourceId'))='data'",
        (RECIPIENT,OWNER),
    ).await?;
    assert_eq!(notices, 1);
    assert!(
        owned_share_sources(&state, user(OWNER))
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.kind == "assistant"
                && entry.source == "data"
                && entry.revision == 3)
    );
    assert!(
        owned_share_sources(&state, user(STRANGER))
            .await
            .unwrap()
            .is_empty()
    );

    let stale = sync_definition(
        &state,
        user(OWNER),
        SyncDefinition {
            root: assistant("data", "Stale prompt"),
            expected_revision: 1,
            assistants: Vec::new(),
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let stale_publication = publish_share(
        &state,
        user(OWNER),
        PublishShare {
            recipient_user_id: STRANGER,
            allow_copy: true,
            root: assistant("data", "Stale prompt"),
            assistants: Vec::new(),
            base_revisions: BTreeMap::from([("assistant:data".into(), 1)]),
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(stale_publication.status(), StatusCode::CONFLICT);
    sync_definition(
        &state,
        user(OWNER),
        SyncDefinition {
            root: team("weekly", true),
            expected_revision: 1,
            assistants: vec![assistant("review", "Review instructions")],
        },
    )
    .await
    .unwrap();
    let latest = get_snapshot(&state, user(RECIPIENT), OWNER, "team", "weekly", "direct")
        .await
        .unwrap();
    assert_eq!(latest.root.revision, 2);
    assert_eq!(latest.assistants.len(), 2);
    assert_eq!(
        latest.assistants[0].definition,
        assistant("data", "Newest prompt")
    );

    revoke_share(&state, user(STRANGER), "team", "weekly", RECIPIENT)
        .await
        .unwrap();
    assert!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "team", "weekly", "direct")
            .await
            .is_ok()
    );
    revoke_share(&state, user(OWNER), "team", "weekly", RECIPIENT)
        .await
        .unwrap();
    assert_eq!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "team", "weekly", "direct")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    assert!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "assistant", "data", "copy")
            .await
            .is_ok()
    );
    revoke_share(&state, user(OWNER), "team", "release", RECIPIENT)
        .await
        .unwrap();
    assert_eq!(
        get_snapshot(&state, user(RECIPIENT), OWNER, "assistant", "data", "copy")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND,
    );
    Ok(())
}
