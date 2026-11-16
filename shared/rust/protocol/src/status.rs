// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatus {
    Running,
    Failed,
    Success,
    Pending,
    Completed,
    Initialized,
    PreExecuted,
    Cancelled,
    Timeout,
}

impl TaskStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "RUNNING",
            Self::Failed => "FAILED",
            Self::Success => "SUCCESS",
            Self::Pending => "PENDING",
            Self::Completed => "COMPLETED",
            Self::Initialized => "INITIALIZED",
            Self::PreExecuted => "PRE_EXECUTED",
            Self::Cancelled => "CANCELLED",
            Self::Timeout => "TIMEOUT",
        }
    }
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}
