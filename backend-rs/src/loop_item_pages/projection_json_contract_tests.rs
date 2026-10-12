// Extracted from projection.rs to keep the module within the file-size bound.

use super::*;
#[test]
fn loop_projection_json_baseline() {
    let dates = [
        "",
        "invalid",
        "2026-09-10T11:51:51Z",
        "2026-09-10T19:51:51.762+08:00",
        "2026-09-10T19:51:51.123456789-05:30",
    ];
    let mut output: Vec<serde_json::Value> = dates
        .iter()
        .map(|date| crate::json_contract_tests::serialized(datetime_reformat(date)).unwrap())
        .collect();
    for status in [
        None,
        Some(""),
        Some("pending"),
        Some("approved"),
        Some("rejected"),
        Some("custom"),
    ] {
        for populated in [false, true] {
            let date = populated.then(|| {
                chrono::NaiveDateTime::parse_from_str("2026-09-12 01:02:03", "%Y-%m-%d %H:%M:%S")
                    .unwrap()
            });
            let execution = ExecutionRow {
                id: 1,
                agent_id: None,
                team_id: None,
                status: None,
                observed_state: None,
                sync_state: None,
                attempt_no: None,
                last_event_seq: None,
                queued_at: date,
                started_at: date,
                completed_at: date,
                lease_expires_at: date,
                heartbeat_at: date,
                error_message: None,
                execution_note: None,
                approval_status: status.map(str::to_owned),
                approved_by_user_id: populated.then_some(0),
                approved_at: date,
                rejected_reason: populated.then(String::new),
                runtime_device_id: None,
                runtime_task_id: None,
                updated_at: date,
            };
            output.push(crate::json_contract_tests::serialized(execution.approval_view()).unwrap());
        }
    }
    crate::json_contract_tests::assert_fixture("loop_projection", output);
}
