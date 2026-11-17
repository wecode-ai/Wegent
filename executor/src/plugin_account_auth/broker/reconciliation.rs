//! Event-driven enrollment with a fixed low-frequency safety audit.
use super::*;
use std::time::Duration;
use tokio::sync::mpsc;

pub(super) async fn run<T: super::super::PluginAuthTransport>(
    transport: T,
    home: PathBuf,
    connected: Arc<AtomicBool>,
    mut cancel: watch::Receiver<bool>,
    mut requested: mpsc::Receiver<u64>,
    interval: Duration,
) {
    let mut inventory = crate::services::capability_activation::subscribe_changes();
    let mut reconciler = super::super::automation::Reconciler::default();
    let mut audit = tokio::time::Instant::now();
    let mut cycle_retry = None;
    let mut failures = 0_u32;
    loop {
        enum Trigger {
            Audit,
            Inventory,
            Targets(Vec<u64>),
            Retry,
        }
        let retry = retry_deadline(
            cycle_retry,
            reconciler.next_retry().map(tokio::time::Instant::from_std),
            transport.available(connected.load(Ordering::Acquire)),
        );
        let trigger = tokio::select! {
            _ = cancel.changed() => break,
            _ = tokio::time::sleep_until(audit) => Trigger::Audit,
            changed = inventory.changed() => {
                if changed.is_err() { break; }
                Trigger::Inventory
            },
            target = requested.recv() => {
                let Some(id) = target else { break; };
                let mut ids = vec![id];
                while let Ok(id) = requested.try_recv() { ids.push(id); }
                ids.sort_unstable(); ids.dedup();
                if ids.contains(&0) { Trigger::Audit } else { Trigger::Targets(ids) }
            },
            _ = async { match retry {
                Some(due) => tokio::time::sleep_until(due).await,
                None => std::future::pending::<()>().await,
            }} => Trigger::Retry,
        };
        // An event never postpones the audit deadline.
        if matches!(trigger, Trigger::Audit) && tokio::time::Instant::now() >= audit {
            audit = tokio::time::Instant::now() + interval;
        }
        if !transport.available(connected.load(Ordering::Acquire)) {
            cycle_retry = Some(tokio::time::Instant::now() + Duration::from_secs(30));
            continue;
        }
        let retry_all = cycle_retry.is_some_and(|due| due <= tokio::time::Instant::now());
        let full_cycle =
            matches!(trigger, Trigger::Audit) || matches!(trigger, Trigger::Retry) && retry_all;
        if full_cycle {
            cycle_retry = None;
        }
        let result = tokio::select! {
            _ = cancel.changed() => break,
            result = async {
                match trigger {
                    Trigger::Audit => reconciler.reconcile(transport.clone(), &home).await,
                    Trigger::Inventory => reconciler.reconcile_changes(transport.clone(), &home).await,
                    Trigger::Targets(ids) => {
                        for id in &ids { reconciler.invalidate(*id); }
                        reconciler.reconcile_selected(transport.clone(), &home, &ids).await
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
