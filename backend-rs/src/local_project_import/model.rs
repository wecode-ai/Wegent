use std::collections::{BTreeMap, HashSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub source: String,
    pub local_user_id: i32,
    pub source_project_id: String,
    pub milestones: Vec<Milestone>,
    pub name: String,
    pub description: String,
    pub settings: BTreeMap<String, Value>,
    pub issues: Vec<Issue>,
    pub comments: Vec<Comment>,
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Milestone {
    pub id: String,
    pub title: String,
    pub description: String,
    pub state: String,
    pub due_on: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Issue {
    pub id: String,
    pub parent_id: Option<String>,
    pub version: i64,
    pub milestone_id: Option<String>,
    pub security_level: String,
    pub assignee_user_id: Option<i32>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub sequence_number: i64,
    pub sort_order: i64,
    pub tags: Vec<String>,
    pub due_at: Option<String>,
    pub start_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub id: String,
    pub issue_id: String,
    pub author: String,
    pub body: String,
    pub reply_to_id: Option<String>,
    pub root_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub issue_id: String,
    pub display_name: String,
    pub content_type: String,
    pub sha256: String,
    pub content: String,
    pub created_at: String,
}

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub fn mapped_id(project: &str, kind: &str, id: &str) -> String {
    format!("import-{}", &hash(format!("{project}\0{kind}\0{id}"))[..48])
}

pub fn datetime(value: &str) -> Result<NaiveDateTime, &'static str> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.naive_utc())
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f"))
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map(|date| date.and_hms_opt(0, 0, 0).unwrap())
        })
        .map_err(|_| "Invalid source timestamp")
}

impl Import {
    pub fn validate(&self) -> Result<Vec<Vec<u8>>, &'static str> {
        if self.source.is_empty() || self.name.trim().is_empty() || self.name.chars().count() > 255
        {
            return Err("Source and project name are required");
        }
        let milestone_ids: HashSet<_> = self.milestones.iter().map(|m| m.id.as_str()).collect();
        if milestone_ids.len() != self.milestones.len() {
            return Err("Duplicate milestone");
        }
        for milestone in &self.milestones {
            if milestone.id.is_empty()
                || milestone.title.trim().is_empty()
                || !matches!(milestone.state.as_str(), "open" | "closed")
            {
                return Err("Invalid milestone");
            }
            if let Some(date) = &milestone.due_on {
                datetime(date)?;
            }
        }
        let ids: HashSet<_> = self.issues.iter().map(|issue| issue.id.as_str()).collect();
        if ids.len() != self.issues.len() || ids.contains("") {
            return Err("Duplicate source Issue");
        }
        for issue in &self.issues {
            if issue
                .milestone_id
                .as_ref()
                .is_some_and(|id| !milestone_ids.contains(id.as_str()))
            {
                return Err("Missing milestone");
            }
            datetime(&issue.created_at)?;
            datetime(&issue.updated_at)?;
            for value in [&issue.due_at, &issue.start_at, &issue.archived_at]
                .into_iter()
                .flatten()
            {
                datetime(value)?;
            }
            if !matches!(issue.security_level.as_str(), "open" | "related")
                || !matches!(
                    issue.priority.as_str(),
                    "none" | "low" | "medium" | "high" | "urgent"
                )
            {
                return Err("Invalid Issue properties");
            }
            if issue.title.is_empty() || issue.title.chars().count() > 255 {
                return Err("Invalid Issue title");
            }
            if issue
                .parent_id
                .as_ref()
                .is_some_and(|id| !ids.contains(id.as_str()))
            {
                return Err("Missing parent Issue");
            }
            let mut parents = HashSet::new();
            let mut current = Some(issue.id.as_str());
            while let Some(id) = current {
                if !parents.insert(id) {
                    return Err("Cyclic Issue parents");
                }
                current = self
                    .issues
                    .iter()
                    .find(|candidate| candidate.id == id)
                    .and_then(|candidate| candidate.parent_id.as_deref());
            }
        }
        let mut comment_ids = HashSet::new();
        for comment in &self.comments {
            if !comment_ids.insert(&comment.id)
                || comment.id.is_empty()
                || !ids.contains(comment.issue_id.as_str())
            {
                return Err("Invalid source comment");
            }
            datetime(&comment.created_at)?;
            datetime(&comment.updated_at)?;
        }
        for comment in &self.comments {
            for reference in [&comment.reply_to_id, &comment.root_id]
                .into_iter()
                .flatten()
            {
                if self
                    .comments
                    .iter()
                    .any(|parent| parent.id == *reference && parent.issue_id != comment.issue_id)
                {
                    return Err("Comment crosses Issue boundaries");
                }
            }
        }
        let mut file_ids = HashSet::new();
        self.attachments
            .iter()
            .map(|file| {
                if !file_ids.insert(&file.id)
                    || file.id.is_empty()
                    || !ids.contains(file.issue_id.as_str())
                {
                    return Err("Invalid source attachment");
                }
                datetime(&file.created_at)?;
                let bytes = STANDARD
                    .decode(&file.content)
                    .map_err(|_| "Invalid attachment content")?;
                if hash(&bytes) != file.sha256 {
                    return Err("Attachment checksum mismatch");
                }
                Ok(bytes)
            })
            .collect()
    }

    pub fn rewrite(&self, project: &str, text: &str) -> String {
        let text = self.issues.iter().fold(text.to_owned(), |text, issue| {
            replace_reference(
                &text,
                &format!("wework-issue://{}/{}", self.source_project_id, issue.id),
                &format!(
                    "wework-issue://{}/{}",
                    project,
                    mapped_id(project, "issue", &issue.id)
                ),
            )
        });
        self.attachments.iter().fold(text, |text, file| {
            let id = mapped_id(project, "attachment", &file.id);
            let text = replace_reference(
                &text,
                &format!("wegent://attachments/{}", file.id),
                &format!("wegent://attachments/{id}"),
            );
            replace_reference(
                &text,
                &format!("wegent-attachment:{}", file.id),
                &format!("wegent-attachment:{id}"),
            )
        })
    }
}

fn replace_reference(text: &str, needle: &str, replacement: &str) -> String {
    let mut result = String::new();
    let mut offset = 0;
    for (index, _) in text.match_indices(needle) {
        let end = index + needle.len();
        if text[end..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace() && !")]>?#/\"'".contains(c))
        {
            continue;
        }
        result.push_str(&text[offset..index]);
        result.push_str(replacement);
        offset = end;
    }
    result.push_str(&text[offset..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn import() -> Import {
        serde_json::from_value(json!({
            "source":"device/project", "local_user_id":0, "source_project_id":"local",
            "name":"Project", "description":"", "settings":{}, "milestones":[],
            "issues":[{"id":"one","version":1,"security_level":"related","title":"Issue",
                "description":"", "status":"pending", "priority":"medium", "sequence_number":1,
                "sort_order":0,"tags":[],"created_at":"2026-11-13T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}],
            "comments":[],"attachments":[]
        })).unwrap()
    }

    #[test]
    fn validates_hierarchy_and_attachment_integrity_before_import() {
        let mut body = import();
        assert!(body.validate().is_ok());
        body.issues[0].parent_id = Some("one".into());
        assert_eq!(body.validate().unwrap_err(), "Cyclic Issue parents");
        body.issues[0].parent_id = None;
        body.attachments.push(Attachment {
            id: "file".into(),
            issue_id: "one".into(),
            display_name: "note.txt".into(),
            content_type: "text/plain".into(),
            sha256: hash("data"),
            content: STANDARD.encode("data"),
            created_at: "2026-11-13".into(),
        });
        assert_eq!(body.validate().unwrap(), vec![b"data".to_vec()]);
        body.attachments[0].content = STANDARD.encode("changed");
        assert_eq!(body.validate().unwrap_err(), "Attachment checksum mismatch");
    }

    #[test]
    fn rewrites_exact_references_without_corrupting_longer_ids() {
        assert_eq!(
            replace_reference(
                "wegent-attachment:1 wegent-attachment:10",
                "wegent-attachment:1",
                "new"
            ),
            "new wegent-attachment:10"
        );
        let body = import();
        let rewritten = body.rewrite(
            "99",
            "[Issue](wework-issue://local/one) private runtime-task://session",
        );
        assert!(rewritten.contains(&mapped_id("99", "issue", "one")));
        assert!(rewritten.contains("runtime-task://session"));
        assert_ne!(
            mapped_id("99", "issue", "one"),
            mapped_id("100", "issue", "one")
        );
    }

    #[test]
    fn import_routes_are_rust_owned_and_runtime_fields_are_rejected() {
        let config = crate::load_routes_config(std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/routes.toml"
        )))
        .unwrap();
        let routes = crate::RouteTable::compile(config).unwrap();
        for method in [http::Method::GET, http::Method::POST] {
            assert!(routes.matches(&method, "/api/v1/cloud-projects/99/import-local"));
        }
        let mut value = serde_json::to_value(import()).unwrap();
        value["runtime_sessions"] = json!(["private"]);
        assert!(serde_json::from_value::<Import>(value).is_err());
    }
}
