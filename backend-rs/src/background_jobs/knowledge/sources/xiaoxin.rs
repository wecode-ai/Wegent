// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Strict HR snapshot validation and deterministic FAQ projection.

use super::{Content, Identity, error};
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    domain: String,
    total: usize,
    #[serde(rename = "list")]
    items: Vec<Value>,
}
#[derive(Deserialize)]
struct Common {
    knowledge_id: i64,
    question: String,
    category: String,
    updated_at: String,
    #[serde(default)]
    similar_questions: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegionAnswer {
    region: String,
    answer: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmployeeAnswer {
    employee_type: String,
    answer: String,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Row {
    category: String,
    id: i64,
    rank: u8,
    scope: String,
    question: String,
    answer: String,
    updated_at: String,
    aliases: Vec<String>,
}

pub async fn fetch(_state: &AppState, identity: &Identity) -> Result<Content> {
    if identity.external_resource_id != "HR" {
        bail!("Unsupported Xiaoxin knowledge domain")
    }
    let started = std::time::Instant::now();
    let payload = pull().await?;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let projection_started = std::time::Instant::now();
    let (markdown, total, filtered, qa) = project(payload).map_err(|_| {
        error(
            "xiaoxin_snapshot_invalid",
            "Xiaoxin snapshot validation failed",
            true,
        )
    })?;
    let projection_elapsed = projection_started.elapsed().as_secs_f64() * 1000.0;
    tracing::info!(
        source_total = total,
        filtered_count = filtered,
        generated_qa_count = qa,
        pull_elapsed_ms = elapsed,
        "Xiaoxin HR snapshot projected"
    );
    Ok(Content{name:"FAQ.md".into(),extension:"md".into(),bytes:markdown.into_bytes(),metadata:json!({"provider":"xiaoxin","resource_id":"HR","domain":"HR","source_total":total,"filtered_count":filtered,"generated_qa_count":qa,"pull_elapsed_ms":elapsed,"projection_elapsed_ms":projection_elapsed,"total_elapsed_ms":started.elapsed().as_secs_f64()*1000.0}).as_object().cloned().unwrap_or_default()})
}

async fn pull() -> Result<Value> {
    let url = crate::config::env_or_dotenv("XIAOXIN_KNOWLEDGE_PULL_URL")
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| {
            error(
                "xiaoxin_pull_not_configured",
                "Xiaoxin pull is not configured",
                true,
            )
        })?;
    let secret = crate::config::env_or_dotenv("XIAOXIN_SIGN_SECRET")
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            error(
                "xiaoxin_pull_not_configured",
                "Xiaoxin pull is not configured",
                true,
            )
        })?;
    let timestamp = Utc::now().timestamp();
    let sign = format!(
        "{:x}",
        Sha256::digest(format!("app_id=robot&timestamp={timestamp}&key={secret}").as_bytes())
    );
    let http = super::http()?;
    let response = http
        .as_reqwest()
        .get(url.trim())
        .query(&[("domain", "HR")])
        .header("X-App-Id", "robot")
        .header("X-Timestamp", timestamp.to_string())
        .header("X-Sign", sign)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|failure| {
            error(
                if failure.is_timeout() {
                    "xiaoxin_pull_timeout"
                } else {
                    "xiaoxin_pull_transport_failed"
                },
                "Xiaoxin pull request failed",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(error(
            "xiaoxin_pull_http_failed",
            "Xiaoxin pull returned an unsuccessful HTTP status",
            true,
        ));
    }
    if let Some(length) = response.headers().get("content-length") {
        length
            .to_str()
            .ok()
            .and_then(|length| length.parse::<u64>().ok())
            .ok_or_else(|| {
                error(
                    "xiaoxin_pull_response_invalid",
                    "Xiaoxin pull returned an invalid content length",
                    true,
                )
            })?;
    }
    let bytes = super::bounded_body(response, 10 * 1024 * 1024)
        .await
        .map_err(|_| {
            error(
                "xiaoxin_pull_response_too_large",
                "Xiaoxin pull response exceeds 10 MB",
                true,
            )
        })?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "xiaoxin_pull_response_invalid",
            "Xiaoxin pull returned invalid JSON",
            true,
        )
    })?;
    if !payload.is_object() {
        return Err(error(
            "xiaoxin_pull_response_invalid",
            "Xiaoxin pull returned invalid JSON",
            true,
        ));
    }
    if payload["code"].as_i64() != Some(0) {
        return Err(error(
            "xiaoxin_pull_business_error",
            "Xiaoxin pull returned a business error",
            true,
        ));
    }
    Ok(payload["data"].clone())
}

fn project(payload: Value) -> Result<(String, usize, usize, usize)> {
    let snapshot: Snapshot = serde_json::from_value(payload).map_err(|_| {
        error(
            "xiaoxin_snapshot_invalid",
            "Xiaoxin snapshot validation failed",
            true,
        )
    })?;
    if snapshot.domain != "HR" || snapshot.total != snapshot.items.len() {
        return Err(error(
            "xiaoxin_snapshot_invalid",
            "Xiaoxin snapshot identity is invalid",
            true,
        ));
    }
    let mut ids = BTreeSet::new();
    let mut rows = vec![];
    let mut filtered = 0;
    for item in snapshot.items {
        let common: Common =
            serde_json::from_value(item.clone()).context("Xiaoxin snapshot validation failed")?;
        if !ids.insert(common.knowledge_id)
            || common.question.trim().is_empty()
            || common.updated_at.trim().is_empty()
        {
            bail!("Xiaoxin snapshot identity is invalid")
        }
        let scope = item["answer_scope"]
            .as_str()
            .context("Xiaoxin answer scope is missing")?;
        let mut allowed = BTreeSet::from([
            "knowledge_id",
            "question",
            "category",
            "updated_at",
            "similar_questions",
            "answer_scope",
        ]);
        let mut answers = vec![];
        match scope {
            "public" => {
                allowed.insert("answer");
                answers.push((
                    0,
                    String::new(),
                    item["answer"]
                        .as_str()
                        .context("Xiaoxin public answer is invalid")?
                        .to_owned(),
                ));
            }
            "region" => {
                allowed.insert("answers");
                let values: Vec<RegionAnswer> = serde_json::from_value(item["answers"].clone())?;
                answers.extend(
                    values
                        .into_iter()
                        .map(|answer| (1, answer.region, answer.answer)),
                );
            }
            "employee" => {
                allowed.insert("answers");
                let values: Vec<EmployeeAnswer> = serde_json::from_value(item["answers"].clone())?;
                answers.extend(
                    values
                        .into_iter()
                        .map(|answer| (2, answer.employee_type, answer.answer)),
                );
            }
            _ => bail!("Xiaoxin answer scope is invalid"),
        }
        if item
            .as_object()
            .context("Xiaoxin item is invalid")?
            .keys()
            .any(|key| !allowed.contains(key.as_str()))
        {
            bail!("Xiaoxin item contains unknown fields")
        }
        let mut scopes = BTreeSet::new();
        if answers.is_empty()
            || answers.iter().any(|(rank, scope, answer)| {
                answer.trim().is_empty()
                    || (*rank != 0 && (scope.trim().is_empty() || !scopes.insert(scope.clone())))
            })
        {
            bail!("Xiaoxin answers are invalid")
        }
        if ["商保体检", "ER政策法规"].contains(&common.category.as_str()) {
            filtered += 1;
            continue;
        }
        for (rank, scope, answer) in answers {
            rows.push(Row {
                category: if common.category.trim().is_empty() {
                    "其他".into()
                } else {
                    common.category.trim().into()
                },
                id: common.knowledge_id,
                rank,
                scope,
                question: inline(&common.question),
                answer: normalize_answer(&answer),
                updated_at: common.updated_at.trim().into(),
                aliases: common
                    .similar_questions
                    .iter()
                    .map(|alias| inline(alias))
                    .filter(|alias| !alias.is_empty())
                    .collect(),
            });
        }
    }
    rows.sort_by(|a, b| {
        (&a.category, a.id, a.rank, &a.scope).cmp(&(&b.category, b.id, b.rank, &b.scope))
    });
    Ok((render(&rows), snapshot.total, filtered, rows.len()))
}

fn inline(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn normalize_answer(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .into()
}
fn render(rows: &[Row]) -> String {
    let mut lines = vec!["# HR FAQ".to_owned(), String::new()];
    let mut category = "";
    for row in rows {
        if category != row.category {
            category = &row.category;
            lines.push(format!("## {category}"));
            lines.push(String::new());
        }
        let (prefix, scope) = match row.rank {
            1 => (
                format!("【{}地区】", row.scope),
                format!("{}地区员工", row.scope),
            ),
            2 => (
                format!("【员工类型{}】", row.scope),
                format!("员工类型为{}的员工", row.scope),
            ),
            _ => (String::new(), "全体员工".into()),
        };
        let aliases = row
            .aliases
            .iter()
            .filter(|alias| *alias != &row.question)
            .cloned()
            .collect::<Vec<_>>();
        let question = format!(
            "{prefix}{}{}",
            row.question,
            if aliases.is_empty() {
                String::new()
            } else {
                format!("（相似问法：{}）", aliases.join("；"))
            }
        );
        lines.extend([
            format!("Q: {question}"),
            String::new(),
            format!("A: 【适用范围】{scope}"),
            row.answer.clone(),
            format!("知识ID：{}", row.id),
            format!("更新时间：{}", row.updated_at),
            String::new(),
        ]);
    }
    format!("{}\n", lines.join("\n").trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Value {
        json!({"knowledge_id":2,"question":" 怎么\n办理 ","category":"其他","updated_at":"today","similar_questions":["怎么办"],"answer_scope":"region","answers":[{"region":"上海","answer":" 带证件 \r\n\r\n来办理 "}]})
    }
    #[test]
    fn projection_is_deterministic_and_keeps_scope_in_each_qa_block() {
        let (text, total, filtered, count) =
            project(json!({"domain":"HR","total":1,"list":[item()]})).unwrap();
        assert_eq!((total, filtered, count), (1, 0, 1));
        assert!(text.contains("Q: 【上海地区】怎么 办理（相似问法：怎么办）"));
        assert!(text.contains("A: 【适用范围】上海地区员工\n带证件\n来办理"));
    }
    #[test]
    fn duplicate_ids_and_unknown_item_fields_are_rejected() {
        assert!(project(json!({"domain":"HR","total":2,"list":[item(),item()]})).is_err());
        let mut bad = item();
        bad["extra"] = true.into();
        assert!(project(json!({"domain":"HR","total":1,"list":[bad]})).is_err());
    }
}
