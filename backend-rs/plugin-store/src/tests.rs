// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_mysql::MysqlError;

fn installation_row(id: i64, device_id: &str) -> PluginDeviceInstallationRow {
    PluginDeviceInstallationRow {
        id,
        installed_kind_id: 9,
        user_id: 3,
        device_id: device_id.to_string(),
        desired_release_id: 4,
        actual_release_id: 0,
        state: "pending".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        last_sync_at: NaiveDateTime::default(),
        updated_at: NaiveDateTime::default(),
    }
}

struct SecondCheckFails {
    calls: std::sync::atomic::AtomicUsize,
}

impl LeaseCheck for SecondCheckFails {
    fn check<'a>(
        &'a self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MysqlResult<()>> + Send + 'a>> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        Box::pin(async move {
            if call >= 2 {
                Err(MysqlError::InvalidQuery {
                    reason: "plugin_write_lease_lost".into(),
                })
            } else {
                Ok(())
            }
        })
    }
}

/// The alias DELETE runs under the first guard; the canonical `device_id`
/// assignment is not executed when the second guard rejects.
#[tokio::test]
async fn a_rejected_post_delete_guard_skips_the_canonical_update() {
    // The retained row still carries a legacy alias, so a successful run
    // must issue the canonical UPDATE.
    let retained = installation_row(1, "retained-legacy");
    let alias = installation_row(2, "legacy-alias");
    let rows = vec![retained.clone(), alias];
    let selected = vec![((1_i64, "canonical".to_string()), retained)];
    let guard = SecondCheckFails {
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let capture = wegent_backend_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let error = converge_plugin_device_rows(&mut session, rows, &selected, Some(&guard))
        .await
        .unwrap_err();
    assert!(matches!(error, MysqlError::InvalidQuery { .. }));
    let writes = capture.writes();
    assert_eq!(writes.len(), 1, "only the DELETE ran");
    assert!(
        writes[0]
            .sql
            .starts_with("DELETE FROM plugin_device_installations")
    );
}

fn installation(
    id: i64,
    installed: i64,
    alias: &str,
    sync: i64,
    updated: i64,
) -> PluginDeviceInstallationRow {
    let epoch = NaiveDateTime::default();
    PluginDeviceInstallationRow {
        id,
        installed_kind_id: installed,
        user_id: 7,
        device_id: alias.into(),
        desired_release_id: 10,
        actual_release_id: 10,
        state: "installed".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        last_sync_at: epoch + chrono::Duration::seconds(sync),
        updated_at: epoch + chrono::Duration::seconds(updated),
    }
}

#[test]
fn pure_coalescing_preserves_selection_priority_and_first_key_order() {
    let rows = vec![
        installation(1, 10, "alias-a", 1, 1),
        installation(2, 20, "alias-b", 1, 1),
        installation(3, 10, "canonical", 1, 1),
        installation(4, 20, "alias-c", 1, 1),
        installation(5, 30, "canonical", 1, 100),
        installation(6, 30, "alias-a", 2, 0),
        installation(7, 40, "alias-a", 1, 1),
        installation(8, 40, "alias-b", 1, 2),
    ];
    let selected = coalesce_plugin_device_rows_resolved(rows, |_, _| "canonical".to_string());
    assert_eq!(
        selected
            .iter()
            .map(|((installed, id), row)| (*installed, id.as_str(), row.id))
            .collect::<Vec<_>>(),
        [
            (10, "canonical", 3),
            (20, "canonical", 2),
            (30, "canonical", 6),
            (40, "canonical", 8)
        ]
    );
}
