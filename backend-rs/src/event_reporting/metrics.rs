// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};

use brz_metrics::{CounterMetric, GaugeMetric, MetricType, ResourceLabels, ResourceMetric};

use super::contract::EventKind;
use super::generated_contract;
use super::runtime::SenderState;

const COUNTER_COUNT: usize = 10;
const EVENT_COUNT: usize = 40;
const STATE_COUNT: usize = 9;

#[derive(Clone, Copy)]
#[repr(usize)]
pub(crate) enum CounterKind {
    Attempted,
    Enqueued,
    Acked,
    Dropped,
    ContractError,
    SerializationError,
    DeliveryFailed,
    DeliveryUnknown,
    Discarded,
    TransportErrors,
}

impl CounterKind {
    const ALL: [Self; COUNTER_COUNT] = [
        Self::Attempted,
        Self::Enqueued,
        Self::Acked,
        Self::Dropped,
        Self::ContractError,
        Self::SerializationError,
        Self::DeliveryFailed,
        Self::DeliveryUnknown,
        Self::Discarded,
        Self::TransportErrors,
    ];

    const fn name(self) -> &'static str {
        match self {
            Self::Attempted => "attempted",
            Self::Enqueued => "enqueued",
            Self::Acked => "acked",
            Self::Dropped => "dropped",
            Self::ContractError => "contract_error",
            Self::SerializationError => "serialization_error",
            Self::DeliveryFailed => "delivery_failed",
            Self::DeliveryUnknown => "delivery_unknown",
            Self::Discarded => "discarded",
            Self::TransportErrors => "transport_errors",
        }
    }
}

pub(crate) struct AtomicCounters {
    total: [AtomicU64; COUNTER_COUNT],
    by_event: [[AtomicU64; COUNTER_COUNT]; EVENT_COUNT],
}

impl Default for AtomicCounters {
    fn default() -> Self {
        Self {
            total: std::array::from_fn(|_| AtomicU64::new(0)),
            by_event: std::array::from_fn(|_| std::array::from_fn(|_| AtomicU64::new(0))),
        }
    }
}

impl AtomicCounters {
    pub(crate) fn increment(&self, event: EventKind, counter: CounterKind) {
        self.add(event, counter, 1);
    }

    pub(crate) fn add(&self, event: EventKind, counter: CounterKind, value: u64) {
        self.total[counter as usize].fetch_add(value, Ordering::Relaxed);
        self.by_event[event.as_index()][counter as usize].fetch_add(value, Ordering::Relaxed);
    }

    pub(crate) fn add_unattributed(&self, counter: CounterKind, value: u64) {
        self.total[counter as usize].fetch_add(value, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self) -> ReporterCounters {
        let value = |counter: CounterKind| self.total[counter as usize].load(Ordering::Relaxed);
        ReporterCounters {
            attempted: value(CounterKind::Attempted),
            enqueued: value(CounterKind::Enqueued),
            acked: value(CounterKind::Acked),
            dropped: value(CounterKind::Dropped),
            contract_error: value(CounterKind::ContractError),
            serialization_error: value(CounterKind::SerializationError),
            delivery_failed: value(CounterKind::DeliveryFailed),
            delivery_unknown: value(CounterKind::DeliveryUnknown),
            discarded: value(CounterKind::Discarded),
            transport_errors: value(CounterKind::TransportErrors),
        }
    }

    fn event_snapshot(&self, event_index: usize) -> [u64; COUNTER_COUNT] {
        std::array::from_fn(|counter| self.by_event[event_index][counter].load(Ordering::Relaxed))
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReporterCounters {
    pub attempted: u64,
    pub enqueued: u64,
    pub acked: u64,
    pub dropped: u64,
    pub contract_error: u64,
    pub serialization_error: u64,
    pub delivery_failed: u64,
    pub delivery_unknown: u64,
    pub discarded: u64,
    pub transport_errors: u64,
}

/// Adapter from fixed-cardinality atomics to the process `brz-metrics`
/// registry. Only the sender task calls this Adapter, so metric handlers stay
/// off the business `emit` path.
pub(crate) struct MetricsPublisher {
    counters: Vec<[CounterMetric; COUNTER_COUNT]>,
    previous: [[u64; COUNTER_COUNT]; EVENT_COUNT],
    queue_events: GaugeMetric,
    queue_bytes: GaugeMetric,
    in_flight_events: GaugeMetric,
    in_flight_bytes: GaugeMetric,
    last_ack: GaugeMetric,
    sender_states: [GaugeMetric; STATE_COUNT],
    previous_state: Option<usize>,
}

impl MetricsPublisher {
    pub(crate) fn new() -> Self {
        debug_assert_eq!(generated_contract::EVENT_TYPES.len(), EVENT_COUNT);
        let counters = generated_contract::EVENT_TYPES
            .iter()
            .map(|event_type| {
                std::array::from_fn(|index| {
                    counter_metric(CounterKind::ALL[index].name(), event_type)
                })
            })
            .collect();
        Self {
            counters,
            previous: [[0; COUNTER_COUNT]; EVENT_COUNT],
            queue_events: gauge_metric("queue_events", "all"),
            queue_bytes: gauge_metric("queue_bytes", "all"),
            in_flight_events: gauge_metric("in_flight_events", "all"),
            in_flight_bytes: gauge_metric("in_flight_bytes", "all"),
            last_ack: gauge_metric("last_ack_timestamp_seconds", "all"),
            sender_states: std::array::from_fn(|index| {
                gauge_metric("sender_state", sender_state_name(index))
            }),
            previous_state: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn publish(
        &mut self,
        counters: &AtomicCounters,
        state: SenderState,
        queue_events: usize,
        queue_bytes: usize,
        in_flight_events: usize,
        in_flight_bytes: usize,
        last_ack_unix_seconds: Option<u64>,
    ) {
        for event_index in 0..EVENT_COUNT {
            let current = counters.event_snapshot(event_index);
            for (counter_index, value) in current.iter().copied().enumerate() {
                let delta = value.saturating_sub(self.previous[event_index][counter_index]);
                if delta > 0 {
                    self.counters[event_index][counter_index].add(delta);
                }
            }
            self.previous[event_index] = current;
        }
        self.queue_events.set(saturating_i64(queue_events));
        self.queue_bytes.set(saturating_i64(queue_bytes));
        self.in_flight_events.set(saturating_i64(in_flight_events));
        self.in_flight_bytes.set(saturating_i64(in_flight_bytes));
        if let Some(last_ack) = last_ack_unix_seconds {
            self.last_ack.set(last_ack.min(i64::MAX as u64) as i64);
        }
        let state_index = state as usize;
        if self.previous_state != Some(state_index) {
            if let Some(previous) = self.previous_state {
                self.sender_states[previous].set(0);
            }
            self.sender_states[state_index].set(1);
            self.previous_state = Some(state_index);
        }
    }
}

fn counter_metric(name: &str, event_type: &str) -> CounterMetric {
    CounterMetric::new_resource(
        MetricType::Service(ResourceMetric::Req),
        &ResourceLabels::new(format!("event_reporting.backend.rust.{name}"), event_type),
    )
}

fn gauge_metric(name: &str, endpoint: &str) -> GaugeMetric {
    GaugeMetric::new_resource(
        MetricType::Service(ResourceMetric::Req),
        &ResourceLabels::new(format!("event_reporting.backend.rust.{name}"), endpoint),
    )
}

fn saturating_i64(value: usize) -> i64 {
    value.min(i64::MAX as usize) as i64
}

const fn sender_state_name(index: usize) -> &'static str {
    match index {
        0 => "disabled",
        1 => "misconfigured",
        2 => "starting",
        3 => "half_open",
        4 => "running",
        5 => "degraded",
        6 => "stopping",
        7 => "stopped",
        _ => "failed",
    }
}
