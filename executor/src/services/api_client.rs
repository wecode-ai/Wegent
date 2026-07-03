// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, time::Duration};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TaskSkillsInfo {
    pub task_id: i64,
    pub team_id: Option<i64>,
    pub team_namespace: Option<String>,
    pub skills: Vec<String>,
    pub preload_skills: Vec<String>,
    pub skill_refs: BTreeMap<String, Value>,
    pub preload_skill_refs: BTreeMap<String, Value>,
}

pub async fn fetch_task_skills(
    api_base_url: &str,
    task_id: &str,
    auth_token: &str,
) -> Result<TaskSkillsInfo, String> {
    let url = format!(
        "{}/api/v1/tasks/{}/skills",
        api_base_url.trim_end_matches('/'),
        task_id.trim()
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|error| format!("failed to fetch task skills: {error}"))?;

    if response.status() != StatusCode::OK {
        return Err(format!(
            "task skills request failed with HTTP {}",
            response.status()
        ));
    }

    response
        .json::<TaskSkillsInfo>()
        .await
        .map_err(|error| format!("failed to parse task skills response: {error}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillApiResponse {
    pub json: Value,
    pub content: Vec<u8>,
}

pub trait SkillApiClient {
    fn get(&self, path: &str, timeout: Duration) -> Option<SkillApiResponse>;
}

pub trait SkillArchiveExtractor {
    fn extract_skill_zip(&self, skill_name: &str, content: &[u8]) -> bool;
}

#[derive(Debug, Clone)]
pub struct SkillDownloader<'a, C, E>
where
    C: SkillApiClient,
    E: SkillArchiveExtractor,
{
    team_namespace: String,
    task_id: Option<String>,
    client: &'a C,
    extractor: &'a E,
}

impl<'a, C, E> SkillDownloader<'a, C, E>
where
    C: SkillApiClient,
    E: SkillArchiveExtractor,
{
    pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
    pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

    pub fn new(
        team_namespace: impl Into<String>,
        task_id: Option<String>,
        client: &'a C,
        extractor: &'a E,
    ) -> Self {
        Self {
            team_namespace: team_namespace.into(),
            task_id,
            client,
            extractor,
        }
    }

    pub fn download_single_skill(
        &self,
        skill_name: &str,
        skill_ref: Option<&BTreeMap<String, Value>>,
    ) -> bool {
        let Some((skill_id, namespace)) = self.resolve_skill(skill_name, skill_ref) else {
            return false;
        };
        let response = self.client.get(
            &self.download_path(skill_id, &namespace),
            Self::DOWNLOAD_TIMEOUT,
        );
        let Some(response) = response else {
            return false;
        };
        self.extractor
            .extract_skill_zip(skill_name, &response.content)
    }

    fn resolve_skill(
        &self,
        skill_name: &str,
        skill_ref: Option<&BTreeMap<String, Value>>,
    ) -> Option<(i64, String)> {
        if let Some(skill_ref) = skill_ref {
            if let Some(skill_id) = value_i64(skill_ref.get("skill_id")) {
                let namespace = skill_ref
                    .get("namespace")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.team_namespace)
                    .to_owned();
                return Some((skill_id, namespace));
            }
        }

        let response = self
            .client
            .get(&self.query_path(skill_name), Self::QUERY_TIMEOUT)?;
        let item = response.json.get("items")?.as_array()?.first()?;
        let metadata = item.get("metadata")?;
        let skill_id = value_i64(metadata.get("labels")?.get("id"))?;
        let namespace = metadata
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned();
        Some((skill_id, namespace))
    }

    fn query_path(&self, skill_name: &str) -> String {
        let mut path = format!(
            "/api/v1/kinds/skills?name={skill_name}&namespace={}",
            self.team_namespace
        );
        if let Some(task_id) = &self.task_id {
            path.push_str(&format!("&task_id={task_id}"));
        }
        path
    }

    fn download_path(&self, skill_id: i64, namespace: &str) -> String {
        let mut path = format!("/api/v1/kinds/skills/{skill_id}/download?namespace={namespace}");
        if let Some(task_id) = &self.task_id {
            path.push_str(&format!("&task_id={task_id}"));
        }
        path
    }
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
    })
}
