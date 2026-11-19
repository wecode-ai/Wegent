// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Observe committed assistant transitions without retaining attempt IDs.

use brz_mysql::{FromMysqlCol, Json, MysqlRow};
use serde_json::Value;

use crate::chat_metrics::RunLabels;

fn column<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Option<T> {
    let index = crate::task_store::subtask_column_index(name)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}

pub(super) fn labels(row: &MysqlRow, task: &MysqlRow) -> RunLabels {
    labels_with_result(row, task, true)
}

pub(super) fn startup_labels(row: &MysqlRow, task: &MysqlRow) -> RunLabels {
    labels_with_result(row, task, false)
}

fn labels_with_result(row: &MysqlRow, task: &MysqlRow, use_persisted: bool) -> RunLabels {
    let task_json = super::task_column::<Json<Value>>(task, "json");
    let result = column::<Json<Value>>(row, "result");
    let executor = column::<String>(row, "executor_name");
    let origin = super::task_column::<String>(task, "client_origin");
    RunLabels::from_task(
        task_json.as_ref().map(|value| &value.0),
        result
            .as_ref()
            .filter(|_| use_persisted)
            .map(|value| &value.0),
        executor.as_deref(),
        origin.as_deref(),
    )
}

pub(super) fn record(
    row: &MysqlRow,
    status: &str,
    code: Option<&str>,
    message: Option<&str>,
    result: Option<&Value>,
    labels: RunLabels,
) {
    if column::<String>(row, "role").as_deref() != Some("ASSISTANT") {
        return;
    }
    let code = result
        .and_then(|value| value.get("error_type"))
        .and_then(Value::as_str)
        .or(code);
    let info = crate::chat_errors::classify_chat_error(code, message);
    crate::chat_metrics::record_terminal(
        status,
        Some(info.code),
        message,
        crate::chat_errors::error_stage(info.code),
        labels,
    );
}
