// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Generation ownership and terminal decisions shared by ingestion jobs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const ACTIVE: [&str; 4] = ["queued", "pending_conversion", "converting", "indexing"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub status: String,
    pub generation: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Enqueue {
        expected: Option<i64>,
        allow_success: bool,
        replace_active: bool,
        stale: bool,
    },
    Start,
    Success,
    Failure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub accepted: bool,
    pub reason: &'static str,
    pub generation: i64,
    pub status: Option<&'static str>,
}

pub fn decide(snapshot: Option<&Snapshot>, generation: i64, event: Event) -> Decision {
    let reject = |reason, generation| Decision {
        accepted: false,
        reason,
        generation,
        status: None,
    };
    let Some(snapshot) = snapshot else {
        return reject("document_not_found", generation);
    };
    if let Event::Enqueue {
        expected,
        allow_success,
        replace_active,
        stale,
    } = event
    {
        if expected.is_some_and(|expected| expected != snapshot.generation) {
            return reject("stale_generation", expected.unwrap_or(generation));
        }
        let active = ACTIVE.contains(&snapshot.status.as_str()) && !replace_active;
        if active && !stale {
            return reject("already_in_progress", snapshot.generation);
        }
        if snapshot.status == "success" && !allow_success {
            return reject("already_indexed", snapshot.generation);
        }
        let Some(next) = snapshot.generation.checked_add(1) else {
            return reject("generation_exhausted", snapshot.generation);
        };
        return Decision {
            accepted: true,
            reason: if active {
                "scheduled_after_stale_recovery"
            } else {
                "scheduled"
            },
            generation: next,
            status: Some("queued"),
        };
    }
    if snapshot.generation != generation {
        return reject("stale_generation", generation);
    }
    let (reason, status) = match event {
        Event::Start => match snapshot.status.as_str() {
            "success" => return reject("already_completed", generation),
            "not_indexed" => return reject("not_scheduled", generation),
            "failed" => return reject("already_failed", generation),
            _ => ("started", "indexing"),
        },
        Event::Success if ["queued", "indexing"].contains(&snapshot.status.as_str()) => {
            ("finalized", "success")
        }
        Event::Failure if ACTIVE.contains(&snapshot.status.as_str()) => ("finalized", "failed"),
        _ => return reject("stale_or_already_finalized", generation),
    };
    Decision {
        accepted: true,
        reason,
        generation,
        status: Some(status),
    }
}

#[derive(Clone, Debug)]
pub struct StaleThresholds {
    pub queued: i64,
    pub pending_conversion: i64,
    pub converting: i64,
    pub indexing: i64,
}

impl StaleThresholds {
    pub fn from_env() -> Self {
        Self {
            queued: seconds("KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS", 600),
            pending_conversion: seconds("KNOWLEDGE_INDEX_STALE_PENDING_CONVERSION_SECONDS", 7200),
            converting: seconds("KNOWLEDGE_INDEX_STALE_CONVERTING_SECONDS", 14400),
            indexing: seconds("KNOWLEDGE_INDEX_STALE_INDEXING_SECONDS", 2700),
        }
    }

    pub fn expired(&self, status: &str, age: Option<i64>) -> bool {
        let threshold = match status {
            "queued" => self.queued,
            "pending_conversion" => self.pending_conversion,
            "converting" => self.converting,
            "indexing" => self.indexing,
            _ => return false,
        };
        age.is_some_and(|age| age >= threshold)
    }
}

pub(super) fn seconds(name: &str, default: i64) -> i64 {
    crate::config::env_or_dotenv(name)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn processing_error(
    stage: &str,
    code: &str,
    message: &str,
    generation: i64,
    now: DateTime<Utc>,
) -> Value {
    json!({
        "stage": stage,
        "code": code,
        "message": message,
        "retryable": true,
        "generation": generation,
        "occurred_at": now.to_rfc3339(),
        "provider": null,
        "model": null,
        "request_id": null,
    })
}

pub fn timeout_error(status: &str, generation: i64, now: DateTime<Utc>) -> Value {
    if ["pending_conversion", "converting"].contains(&status) {
        processing_error(
            "conversion",
            "conversion_timeout",
            "Document conversion timed out. Please retry.",
            generation,
            now,
        )
    } else {
        processing_error(
            "indexing",
            "indexing_timeout",
            "Document indexing timed out. Please retry.",
            generation,
            now,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(status: &str, generation: i64) -> Snapshot {
        Snapshot {
            status: status.into(),
            generation,
        }
    }

    #[test]
    fn a_superseded_attempt_cannot_start_or_finalize() {
        for event in [Event::Start, Event::Success, Event::Failure] {
            let result = decide(Some(&snapshot("indexing", 8)), 7, event);
            assert!(!result.accepted);
            assert_eq!(result.reason, "stale_generation");
        }
    }

    #[test]
    fn queued_conversion_cannot_be_finalized_as_an_index_success() {
        assert!(!decide(Some(&snapshot("converting", 2)), 2, Event::Success).accepted);
        assert!(decide(Some(&snapshot("converting", 2)), 2, Event::Failure).accepted);
    }

    #[test]
    fn enqueue_requires_a_new_generation_and_explicit_replacement() {
        let event = Event::Enqueue {
            expected: Some(3),
            allow_success: false,
            replace_active: false,
            stale: false,
        };
        assert!(!decide(Some(&snapshot("queued", 3)), 3, event).accepted);
        let replacement = Event::Enqueue {
            expected: Some(3),
            allow_success: true,
            replace_active: true,
            stale: false,
        };
        let result = decide(Some(&snapshot("queued", 3)), 3, replacement);
        assert!(result.accepted);
        assert_eq!(result.generation, 4);
        assert_eq!(result.status, Some("queued"));
    }

    #[test]
    fn completed_documents_do_not_reenter_indexing_from_old_delivery() {
        let result = decide(Some(&snapshot("success", 4)), 4, Event::Start);
        assert!(!result.accepted);
        assert_eq!(result.reason, "already_completed");
    }

    #[test]
    fn timeout_includes_the_boundary_and_never_marks_terminal_or_unknown_ages() {
        let thresholds = StaleThresholds {
            queued: 10,
            pending_conversion: 20,
            converting: 20,
            indexing: 45,
        };
        assert!(!thresholds.expired("queued", Some(9)));
        assert!(thresholds.expired("queued", Some(10)));
        assert!(!thresholds.expired("success", Some(1000)));
        assert!(!thresholds.expired("indexing", None));
        let error = timeout_error("converting", 4, DateTime::from_timestamp(0, 0).unwrap());
        assert_eq!(error["code"], "conversion_timeout");
        assert_eq!(error["generation"], 4);
    }
}
