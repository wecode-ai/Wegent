//! Native archive receipts describe archived sessions; restore receipts describe
//! current sessions after applying the verified archive bytes.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalIdentity {
    pub id: String,
    pub objective: String,
    pub token_budget: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivedGoal {
    pub id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<i64>,
    pub created_at_ms: i64,
    pub continuation_deferred: bool,
    pub snapshot_sha256: String,
}

impl ArchivedGoal {
    pub fn identity(&self) -> GoalIdentity {
        GoalIdentity {
            id: self.id.clone(),
            objective: self.objective.clone(),
            token_budget: self.token_budget,
            created_at_ms: self.created_at_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivedSession {
    pub bot_id: Option<String>,
    pub engine: String,
    pub id: String,
    pub goal: Option<ArchivedGoal>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionArchiveReceipt {
    pub version: u32,
    pub task_id: String,
    pub sha256: String,
    pub sessions: Vec<ArchivedSession>,
}

impl SessionArchiveReceipt {
    pub fn valid_for_task(&self, task: i64) -> bool {
        self.version == 1
            && task > 0
            && self.task_id == task.to_string()
            && self.sha256.len() == 64
            && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    }
    /// Legacy unscoped markers do not prove which Bot's conversation was archived.
    pub fn session(&self, task: i64, bot: i64, engine: &str, id: &str) -> Option<&ArchivedSession> {
        if !self.valid_for_task(task) || bot <= 0 {
            return None;
        }
        let bot = bot.to_string();
        let mut matches = self.sessions.iter().filter(|session| {
            session.bot_id.as_deref() == Some(bot.as_str())
                && session.engine == engine
                && session.id == id
        });
        let matched = matches.next()?;
        matches.next().is_none().then_some(matched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipts_require_exact_task_bot_session_and_unambiguous_native_evidence() {
        let mut receipt = SessionArchiveReceipt {
            version: 1,
            task_id: "42".into(),
            sha256: "a".repeat(64),
            sessions: vec![ArchivedSession {
                bot_id: Some("23".into()),
                engine: "Codex".into(),
                id: "original-thread".into(),
                goal: None,
            }],
        };
        assert!(receipt
            .session(42, 23, "Codex", "original-thread")
            .is_some());
        for (task, bot, engine, id) in [
            (43, 23, "Codex", "original-thread"),
            (42, 24, "Codex", "original-thread"),
            (42, 23, "ClaudeCode", "original-thread"),
            (42, 23, "Codex", "replacement-thread"),
        ] {
            assert!(receipt.session(task, bot, engine, id).is_none());
        }
        receipt.sessions.push(receipt.sessions[0].clone());
        assert!(receipt
            .session(42, 23, "Codex", "original-thread")
            .is_none());
        receipt.sessions.pop();
        receipt.sessions[0].bot_id = None;
        assert!(receipt
            .session(42, 23, "Codex", "original-thread")
            .is_none());
        receipt.sessions[0].bot_id = Some("23".into());
        receipt.sha256 = "not-an-archive-digest".into();
        assert!(receipt
            .session(42, 23, "Codex", "original-thread")
            .is_none());
    }
}
