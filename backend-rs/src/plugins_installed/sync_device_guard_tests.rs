#![cfg(test)]

//! Guard-boundary tests for the plugin pending flush.

use super::*;

struct FailingGuard {
    calls: std::sync::atomic::AtomicUsize,
    fail_at: usize,
}

impl crate::device_identity::LeaseCheck for FailingGuard {
    fn check<'a>(
        &'a self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = brz_mysql::MysqlResult<()>> + Send + 'a>>
    {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let fail = call >= self.fail_at;
        Box::pin(async move {
            if fail {
                Err(brz_mysql::MysqlError::InvalidQuery {
                    reason: "plugin_write_lease_lost".into(),
                })
            } else {
                Ok(())
            }
        })
    }
}

#[tokio::test]
async fn a_dirty_flush_checks_the_lease_even_without_writes() {
    let guard = FailingGuard {
        calls: std::sync::atomic::AtomicUsize::new(0),
        fail_at: usize::MAX,
    };
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let mut flush = PendingFlush {
        assigned: true,
        ..PendingFlush::default()
    };
    flush
        .flush_with_guard(&mut session, &[], Some(&guard))
        .await
        .unwrap();
    assert_eq!(guard.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(capture.writes().is_empty());
}

#[tokio::test]
async fn a_rejected_guard_prevents_the_pending_insert() {
    let guard = FailingGuard {
        calls: std::sync::atomic::AtomicUsize::new(0),
        fail_at: 1,
    };
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let mut flush = PendingFlush {
        assigned: true,
        ..PendingFlush::default()
    };
    flush.inserts.push(DesiredInsert {
        installed_kind_id: 1,
        user_id: 2,
        device_id: "device".into(),
        release_id: 3,
        now: chrono::Local::now().naive_local(),
    });
    let error = flush
        .flush_with_guard(&mut session, &[], Some(&guard))
        .await
        .unwrap_err();
    assert!(matches!(error, brz_mysql::MysqlError::InvalidQuery { .. }));
    assert!(capture.writes().is_empty());
}
