//! Event-driven enrollment with a fixed low-frequency safety audit.
use super::super::automation::{PendingLogins, Reconciler};
use super::*;
use std::time::Duration;
use tokio::sync::mpsc;

pub(super) async fn run<T: super::super::PluginAuthTransport>(
    transport: T,
    home: PathBuf,
    connected: Arc<AtomicBool>,
    mut cancel: watch::Receiver<bool>,
    mut requested: mpsc::Receiver<ReconciliationRequest>,
    pending_logins: Arc<PendingLogins>,
    interval: Duration,
) {
    let mut inventory = crate::services::capability_activation::subscribe_changes();
    let mut reconciler = Reconciler::new(pending_logins.clone());
    let mut audit = tokio::time::Instant::now();
    let mut cycle_retry = None;
    let mut failures = 0_u32;
    loop {
        enum Trigger {
            Audit,
            Inventory,
            Login,
            Requests(Vec<ReconciliationRequest>),
            Retry,
        }
        let retry = retry_deadline(
            cycle_retry,
            reconciler.next_retry().map(tokio::time::Instant::from_std),
            transport.available(connected.load(Ordering::Acquire)),
        );
        let mut trigger = tokio::select! {
            biased;
            _ = cancel.changed() => break,
            _ = pending_logins.notified() => Trigger::Login,
            target = requested.recv() => {
                let Some(first) = target else { break; };
                let mut events = vec![first];
                while let Ok(event) = requested.try_recv() { events.push(event); }
                Trigger::Requests(events)
            },
            _ = tokio::time::sleep_until(audit) => Trigger::Audit,
            changed = inventory.changed() => {
                if changed.is_err() { break; }
                Trigger::Inventory
            },
            _ = async { match retry {
                Some(due) => tokio::time::sleep_until(due).await,
                None => std::future::pending::<()>().await,
            }} => Trigger::Retry,
        };
        if tokio::time::Instant::now() >= audit {
            if let Trigger::Requests(events) = &mut trigger {
                events.push(ReconciliationRequest::Audit);
            }
        }
        let scheduled_audit = matches!(trigger, Trigger::Audit)
            || matches!(&trigger, Trigger::Requests(events) if events.iter().any(|event| matches!(event, ReconciliationRequest::Audit)));
        // An event never postpones the audit deadline.
        if scheduled_audit && tokio::time::Instant::now() >= audit {
            audit = tokio::time::Instant::now() + interval;
        }
        if !transport.available(connected.load(Ordering::Acquire)) {
            cycle_retry = Some(tokio::time::Instant::now() + Duration::from_secs(30));
            continue;
        }
        let retry_all = cycle_retry.is_some_and(|due| due <= tokio::time::Instant::now());
        let full_cycle = scheduled_audit || matches!(trigger, Trigger::Retry) && retry_all;
        if full_cycle {
            cycle_retry = None;
        }
        let result = tokio::select! {
            _ = cancel.changed() => break,
            result = async {
                match trigger {
                    Trigger::Audit => reconciler.reconcile(transport.clone(), &home).await,
                    Trigger::Inventory => reconciler.reconcile_changes(transport.clone(), &home).await,
                    Trigger::Login => reconciler.reconcile_logins(transport.clone(), &home).await,
                    Trigger::Requests(events) => {
                        reconcile_requested(&mut reconciler, transport.clone(), &home, events).await
                    },
                    Trigger::Retry if retry_all => reconciler.reconcile(transport.clone(), &home).await,
                    Trigger::Retry => reconciler.reconcile_due(transport.clone(), &home).await,
                }
            } => result,
        };
        match result {
            Ok(()) if full_cycle => failures = 0,
            Ok(()) => {}
            Err(_) => {
                failures = failures.saturating_add(1);
                let due = tokio::time::Instant::now()
                    + Duration::from_secs(match failures {
                        1 => 30,
                        2 => 60,
                        _ => 300,
                    });
                cycle_retry = Some(cycle_retry.map_or(due, |previous| previous.min(due)));
            }
        }
        if let Some(path) = super::super::e2e_reconcile_marker() {
            if let Ok(mut marker) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(marker, "reconciled");
            }
        }
    }
}

async fn reconcile_requested<T: super::super::PluginAuthTransport>(
    reconciler: &mut Reconciler,
    transport: T,
    home: &std::path::Path,
    events: Vec<ReconciliationRequest>,
) -> Result<(), AuthError> {
    let mut ordinary = Vec::new();
    let mut audit = false;
    for event in events {
        match event {
            ReconciliationRequest::Audit => audit = true,
            ReconciliationRequest::Target(id) => ordinary.push(id),
        }
    }
    for id in &ordinary {
        reconciler.invalidate(*id);
    }
    if audit {
        return reconciler.reconcile(transport, home).await;
    }
    if !ordinary.is_empty() {
        reconciler
            .reconcile_selected(transport, home, &ordinary)
            .await?;
    }
    Ok(())
}

fn retry_deadline(
    cycle: Option<tokio::time::Instant>,
    target: Option<tokio::time::Instant>,
    available: bool,
) -> Option<tokio::time::Instant> {
    [cycle, target.filter(|_| available)]
        .into_iter()
        .flatten()
        .min()
}

pub(super) fn audit_interval(seed: u8) -> Duration {
    let audit = default_audit_interval(seed);
    super::super::e2e_duration("WEWORK_E2E_PLUGIN_ACCOUNT_RECONCILE_INTERVAL_MS", audit)
}

fn default_audit_interval(seed: u8) -> Duration {
    Duration::from_secs(270 + u64::from(seed) % 61)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn offline_transport_ignores_expired_target_deadlines() {
        let past = tokio::time::Instant::now();
        tokio::time::advance(Duration::from_secs(31)).await;
        let backoff = tokio::time::Instant::now() + Duration::from_secs(30);
        assert_eq!(
            retry_deadline(Some(backoff), Some(past), false),
            Some(backoff)
        );
        assert_eq!(retry_deadline(None, Some(past), false), None);
        assert_eq!(retry_deadline(Some(backoff), Some(past), true), Some(past));
    }

    #[test]
    fn audit_cadence_is_five_minutes_with_bounded_jitter() {
        for seed in 0_u8..=255 {
            let seconds = default_audit_interval(seed).as_secs();
            assert!((270..=330).contains(&seconds));
        }
    }
}

#[cfg(test)]
#[path = "reconciliation/tests.rs"]
mod event_tests;
