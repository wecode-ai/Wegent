// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gateway MySQL fixtures for the project metrics transaction contracts.

use std::collections::BTreeSet;

use brz_http_server::StatusCode;
use brz_mysql::{Json, MysqlService};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};
use wegent_project_coordination::cloud_projects::metrics_test_support::{
    ProjectData, completed_in_window, load_issues, project_data_on, snapshot_options, v2,
};

use crate::http_compat::FastApiError;

#[path = "collaboration_metrics_mysql_tests.rs"]
mod mysql_tests;
