use super::*;
use crate::wework_transcript_segment_manifest::*;
use chrono::NaiveDate;

fn transcript() -> TranscriptRow {
    TranscriptRow {
        id: 1888,
        transcript_id: "runtime-659758236".to_string(),
        parent_transcript_id: String::new(),
        forked_at_sequence: 0,
        title: "iphone appstore的app购买记录怎么删除".to_string(),
        state: "active".to_string(),
        current_sequence: 2,
        archived_through_sequence: 1,
        writer_client_id: "1fe8e147-034c-4a0a-b721-18faf03548bb".to_string(),
        writer_fencing_token: 3,
        writer_lease_expires_at: datetime(2026, 10, 16, 3, 10, 15),
        archived_at: EPOCH_TIME,
        created_at: datetime(2026, 10, 16, 3, 1, 11),
        updated_at: datetime(2026, 10, 16, 3, 5, 15),
    }
}

fn datetime(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(year, month, day)
        .unwrap()
        .and_hms_opt(hour, minute, second)
        .unwrap()
}

fn recorded_metadata() -> String {
    json!({
        "clientId": "1fe8e147-034c-4a0a-b721-18faf03548bb",
        "baseSequence": 2,
        "fencingToken": 3,
        "title": "iphone appstore的app购买记录怎么删除",
        "sequence": 3,
        "sha256": "e5e6e9c221633b84af74dc248121ca9ba8805ec33595a6eb9a2d85aa714b0dce",
        "sizeBytes": 3766,
        "format": "codex-delta.v1.tgz.aes256gcm",
        "turnId": "aig-9KY6uv1jw150du-aRxdcrBZsOL9k76FJ4vHSvYs",
        "summary": {
            "userMessages": [{"id": "queued-runtime-pane-1792119862699-0", "text": "有没有办法删除呢"}],
            "assistantMessage": "没办法删除。",
            "reasoning": "",
            "completion": {"kind": "completed"},
            "taskId": "runtime-659758236",
        },
    })
    .to_string()
}

#[test]
fn recorded_manifest_parses() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    assert_eq!(request.client_id, "1fe8e147-034c-4a0a-b721-18faf03548bb");
    assert_eq!(request.base_sequence, 2);
    assert_eq!(request.fencing_token, 3);
    assert_eq!(request.sequence, 3);
    assert_eq!(request.size_bytes, 3766);
    assert_eq!(request.format, "codex-delta.v1.tgz.aes256gcm");
    assert_eq!(
        request.turn_id,
        "aig-9KY6uv1jw150du-aRxdcrBZsOL9k76FJ4vHSvYs"
    );
    assert!(request.summary.is_object());
}

#[test]
fn snake_case_names_are_accepted() {
    let raw = json!({
        "client_id": "device",
        "base_sequence": 0,
        "fencing_token": 1,
        "sequence": 1,
        "sha256": "a".repeat(64),
        "size_bytes": 1,
        "format": "codex-snapshot.v1.tgz.aes256gcm",
        "turn_id": "turn",
        "summary": {},
    })
    .to_string();
    let request = parse_segment_request(&raw).unwrap();
    assert_eq!(request.client_id, "device");
    assert_eq!(request.summary, json!({}));
}

#[test]
fn invalid_json_renders_the_pydantic_json_invalid_error() {
    let error = parse_segment_request("not json").unwrap_err();
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], "json_invalid");
    assert_eq!(detail[0]["loc"], json!([]));
    assert_eq!(detail[0]["input"], "not json");
    assert_eq!(
        detail[0]["url"],
        "https://errors.pydantic.dev/2.12/v/json_invalid"
    );
}

#[test]
fn non_object_json_renders_the_model_type_error() {
    let error = parse_segment_request("[]").unwrap_err();
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], "model_type");
    assert_eq!(detail[0]["msg"], "Input should be an object");
    assert_eq!(
        detail[0]["ctx"]["class_name"],
        "TranscriptSegmentCommitRequest"
    );
}

#[test]
fn missing_fields_render_in_declaration_order() {
    let error = parse_segment_request("{}").unwrap_err();
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    let locs: Vec<&str> = detail
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["loc"][0].as_str().unwrap())
        .collect();
    assert_eq!(
        locs,
        vec![
            "clientId",
            "baseSequence",
            "fencingToken",
            "sequence",
            "sha256",
            "sizeBytes",
            "format",
            "turnId",
            "summary"
        ]
    );
    assert_eq!(detail[0]["msg"], "Field required");
    assert_eq!(detail[0]["input"], json!({}));
}

#[test]
fn field_constraints_render_pydantic_messages() {
    let raw = json!({
        "clientId": "",
        "baseSequence": -1,
        "fencingToken": 0,
        "title": 5,
        "sequence": 0,
        "sha256": "abc",
        "sizeBytes": 0,
        "format": "x",
        "turnId": "",
        "summary": [],
    })
    .to_string();
    let error = parse_segment_request(&raw).unwrap_err();
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], "string_too_short");
    assert_eq!(detail[1]["type"], "greater_than_equal");
    assert_eq!(detail[2]["ctx"], json!({"ge": 1}));
    assert_eq!(detail[3]["type"], "string_type");
    assert_eq!(detail[5]["type"], "string_pattern_mismatch");
    assert_eq!(detail[5]["ctx"]["pattern"], SHA256_PATTERN);
    assert_eq!(detail[6]["type"], "greater_than");
    assert_eq!(detail[6]["ctx"], json!({"gt": 0}));
    assert_eq!(detail[7]["type"], "string_pattern_mismatch");
    assert_eq!(detail[7]["ctx"]["pattern"], FORMAT_PATTERN);
    assert_eq!(detail[8]["type"], "string_too_short");
    assert_eq!(detail[9]["type"], "dict_type");
}

#[test]
fn oversized_segment_is_rejected_with_the_schema_bound() {
    let raw = json!({
        "clientId": "a",
        "baseSequence": 0,
        "fencingToken": 1,
        "sequence": 1,
        "sha256": "a".repeat(64),
        "sizeBytes": MAX_SEGMENT_BYTES + 1,
        "format": "codex-delta.v1.tgz.aes256gcm",
        "turnId": "t",
        "summary": {},
    })
    .to_string();
    let error = parse_segment_request(&raw).unwrap_err();
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], "less_than_equal");
    assert_eq!(detail[0]["ctx"]["le"], MAX_SEGMENT_BYTES);
}

#[test]
fn lax_integer_coercion_matches_pydantic() {
    assert_eq!(parse_int(&json!(true)), Ok(1));
    assert_eq!(parse_int(&json!("7")), Ok(7));
    assert_eq!(parse_int(&json!(2.0)), Ok(2));
    assert!(parse_int(&json!(1.5)).is_err());
    assert!(parse_int(&json!(null)).is_err());
}

#[test]
fn recorded_delta_updates_sequence_and_audit_time_only() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    let now = datetime(2026, 10, 16, 3, 5, 15);
    let plan = transcript_update_plan(&transcript(), &request, 3, now);
    assert_eq!(plan.set_clause, "current_sequence=?, updated_at=?");
    assert_eq!(plan.row_id, 1888);
    assert_eq!(plan.binds[0], SegmentBind::Int(3));
    assert_eq!(
        plan.binds[1],
        SegmentBind::Text("2026-10-16 03:05:15.000000".to_string())
    );
}

#[test]
fn snapshot_updates_the_archived_through_sequence() {
    let mut request = parse_segment_request(&recorded_metadata()).unwrap();
    request.format = "codex-snapshot.v1.tgz.aes256gcm".to_string();
    let now = datetime(2026, 10, 16, 3, 5, 15);
    let plan = transcript_update_plan(&transcript(), &request, 0, now);
    assert_eq!(
        plan.set_clause,
        "current_sequence=?, archived_through_sequence=?, updated_at=?"
    );
    assert_eq!(plan.binds[1], SegmentBind::Int(3));
}

#[test]
fn changed_title_and_reactivated_state_follow_mapper_order() {
    let mut request = parse_segment_request(&recorded_metadata()).unwrap();
    request.title = Some("new title".to_string());
    let mut stored = transcript();
    stored.state = "archived".to_string();
    stored.archived_at = datetime(2026, 10, 1, 0, 0, 0);
    let now = datetime(2026, 10, 16, 3, 5, 15);
    let plan = transcript_update_plan(&stored, &request, 3, now);
    assert_eq!(
        plan.set_clause,
        "title=?, state=?, current_sequence=?, archived_at=?, updated_at=?"
    );
    assert_eq!(plan.binds[0], SegmentBind::Text("new title".to_string()));
    assert_eq!(
        plan.binds[3],
        SegmentBind::Text("1970-01-01 00:00:00.000000".to_string())
    );
    assert_eq!(
        plan.binds[4],
        SegmentBind::Text("2026-10-16 03:05:15.000000".to_string())
    );
}

#[test]
fn segment_object_key_is_content_addressed_like_the_source() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    let key = segment_object_key(6519, "runtime-659758236", &request);
    assert_eq!(
        key,
        "users/6519/transcripts/386994f7b49b42c6a2c979111496c0126c1b295b555d011f3ee62603d0e13a2d/\
         3-delta-e5e6e9c221633b84af74dc248121ca9ba8805ec33595a6eb9a2d85aa714b0dce.tgz.aes256gcm"
    );
    let mut snapshot = request.clone();
    snapshot.format = "codex-snapshot.v1.tgz.aes256gcm".to_string();
    assert!(segment_object_key(6519, "runtime-659758236", &snapshot).contains("-snapshot-"));
}

#[test]
fn segment_match_requires_every_manifest_field() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    let key = segment_object_key(6519, "runtime-659758236", &request);
    let archive = ArchiveRow {
        id: 1,
        from_sequence: 3,
        to_sequence: 3,
        storage_key: key.clone(),
        sha256: request.sha256.clone(),
        size_bytes: request.size_bytes,
        format: request.format.clone(),
        created_at: datetime(2026, 10, 16, 3, 5, 15),
    };
    assert!(segment_matches(&archive, 3, &key, &request));
    assert!(!segment_matches(&archive, 0, &key, &request));
}

#[test]
fn response_renders_camel_case_with_the_source_field_order() {
    let body = crate::json_contract_tests::serialized(TranscriptAppendResponse {
        current_sequence: 3,
        appended: 1,
    })
    .unwrap();
    assert_eq!(body.to_string(), r#"{"currentSequence":3,"appended":1}"#);
}

#[test]
fn turn_payload_uses_python_json_dumps_rendering() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    let payload = python_json_value(&request.summary);
    // `json.dumps` defaults: `", "`/`": "` separators and `ensure_ascii`.
    assert!(payload.starts_with(
        "{\"userMessages\": [{\"id\": \"queued-runtime-pane-1792119862699-0\", \
         \"text\": \"\\u6709\\u6ca1\\u6709\\u529e\\u6cd5\\u5220\\u9664\\u5462\"}]"
    ));
    assert!(payload.ends_with("\"taskId\": \"runtime-659758236\"}"));
}

#[test]
fn dump_only_locks_the_owned_transcript() {
    let sql = format!("{TRANSCRIPT_BY_ID_QUERY} FOR UPDATE");
    assert!(sql.ends_with("LIMIT 1 FOR UPDATE"));
    assert!(
        EXISTING_ARCHIVE_QUERY.ends_with(
            "transcript_db_id = ? AND wework_transcript_archives.to_sequence = ? LIMIT 1"
        )
    );
    assert!(
        EXISTING_TURN_QUERY.contains(
            "(wework_transcript_turns.sequence = ? OR wework_transcript_turns.turn_id = ?)"
        )
    );
    assert_eq!(
        INSERT_ARCHIVE_QUERY.split_whitespace().collect::<Vec<_>>()[0..4],
        [
            "INSERT",
            "INTO",
            "wework_transcript_archives",
            "(transcript_db_id,"
        ]
    );
    assert!(PRUNE_OBSOLETE_QUERY.trim_end().ends_with("LIMIT 20"));
    assert_eq!(MAX_SEGMENTS_PRUNED_PER_COMMIT, 20);
}

#[test]
fn lease_requires_client_token_and_an_unexpired_lease() {
    let request = parse_segment_request(&recorded_metadata()).unwrap();
    let stored = transcript();
    assert!(lease_valid(
        &stored,
        &request,
        datetime(2026, 10, 16, 3, 5, 15)
    ));
    assert!(!lease_valid(
        &stored,
        &request,
        datetime(2026, 10, 16, 3, 10, 15)
    ));
    let mut other = request.clone();
    other.fencing_token = 4;
    assert!(!lease_valid(
        &stored,
        &other,
        datetime(2026, 10, 16, 3, 5, 15)
    ));
}
