//! Event-driven enrollment with a fixed low-frequency safety audit.
use super::super::automation::{PendingLogins, Reconciler};
use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::{path::Path, time::Duration};
use tokio::sync::mpsc;

pub(super) async fn run<T: super::super::PluginAuthTransport>(
    transport: T,
    home: PathBuf,
    connected: Arc<AtomicBool>,
    cancel: watch::Receiver<bool>,
    requested: mpsc::Receiver<ReconciliationRequest>,
    pending_logins: Arc<PendingLogins>,
    interval: Duration,
) {
    // Foreground registration has its own capacity and cannot wait behind an
    // ordinary audit's provider calls. The reconciler serializes each installation.
    tokio::select! {
        biased;
        _ = run_logins(transport.clone(), &home, &connected, cancel.clone(), pending_logins.clone()) => {},
        _ = run_ordinary(transport, &home, &connected, cancel, requested, pending_logins, interval) => {},
    }
}

async fn run_logins<T: super::super::PluginAuthTransport>(
    transport: T,
    home: &Path,
    connected: &AtomicBool,
    mut cancel: watch::Receiver<bool>,
    pending_logins: Arc<PendingLogins>,
) {
    let actions = Arc::new(Semaphore::new(1));
    let mut batches = FuturesUnordered::new();
    let mut offline_retry = None;
    loop {
        let next = if batches.len() < 16 {
            pending_logins
                .next_ready()
                .map(|due| offline_retry.map_or(due, |retry| due.max(retry)))
        } else {
            None
        };
        tokio::select! {
            biased;
            _ = cancel.changed() => break,
            _ = pending_logins.notified() => {
                if transport.available(connected.load(Ordering::Acquire)) {
                    offline_retry = None;
                }
                continue;
            },
            _ = batches.next(), if !batches.is_empty() => {
                write_cycle_marker();
                continue;
            },
            _ = wait_for_retry(next) => {},
        };
        if !transport.available(connected.load(Ordering::Acquire)) {
            offline_retry = Some(tokio::time::Instant::now() + Duration::from_secs(30));
            continue;
        }
        offline_retry = None;
        let batch = pending_logins.take();
        let mut reconciler = Reconciler::new(pending_logins.clone());
        let transport = transport.clone();
        let home = home.to_owned();
        let actions = actions.clone();
        batches.push(async move {
            if let Err(error) = reconciler
                .reconcile_logins(transport, &home, batch, actions)
                .await
            {
                crate::logging::log_executor_event(
                    "plugin auth login registration discovery failed",
                    &[("code", error.0.to_owned())],
                );
            }
        });
    }
}

async fn run_ordinary<T: super::super::PluginAuthTransport>(
    transport: T,
    home: &Path,
    connected: &AtomicBool,
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
    let mut owner_revision = pending_logins.revision();
    loop {
        let revision = pending_logins.revision();
        if revision != owner_revision {
            owner_revision = revision;
            cycle_retry = None;
            failures = 0;
        }
        enum Trigger {
            Audit,
            Inventory,
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
            _ = wait_for_retry(retry) => Trigger::Retry,
        };
        if tokio::time::Instant::now() >= audit {
            if let Trigger::Requests(events) = &mut trigger {
                events.push(ReconciliationRequest::Audit);
            }
        }
        let revision = pending_logins.revision();
        if revision != owner_revision {
            owner_revision = revision;
            cycle_retry = None;
            failures = 0;
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
                    Trigger::Audit => reconciler.reconcile(transport.clone(), home).await,
                    Trigger::Inventory => reconciler.reconcile_changes(transport.clone(), home).await,
                    Trigger::Requests(events) => {
                        reconcile_requested(&mut reconciler, transport.clone(), home, events).await
                    },
                    Trigger::Retry if retry_all => reconciler.reconcile(transport.clone(), home).await,
                    Trigger::Retry => reconciler.reconcile_due(transport.clone(), home).await,
                }
            } => result,
        };
        if pending_logins.revision() != revision {
            continue;
        }
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
        write_cycle_marker();
    }
}

async fn wait_for_retry(retry: Option<tokio::time::Instant>) {
    match retry {
        Some(due) if due > tokio::time::Instant::now() => tokio::time::sleep_until(due).await,
        Some(_) => {}
        None => std::future::pending::<()>().await,
    }
}

fn write_cycle_marker() {
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
