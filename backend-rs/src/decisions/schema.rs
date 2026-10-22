// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The provider-independent decision request contract.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug)]
pub(super) struct DecisionRequest {
    pub model: String,
    pub state: Value,
    pub questions: Vec<(String, Question)>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest {
    model: String,
    state: Value,
    questions: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum QuestionType {
    Noul,
    Choice,
    Score,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Question {
    #[serde(rename = "type")]
    pub kind: QuestionType,
    pub instructions: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<Value>,
}

pub(super) fn valid_model_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/:-".contains(&byte))
}

fn structured(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Object(_) | Value::Array(_))
}

impl DecisionRequest {
    pub fn parse(body: &[u8]) -> Result<Self, ()> {
        let value: Value = serde_json::from_slice(body).map_err(|_| ())?;
        if !value.is_object() {
            return Err(());
        }
        let raw: RawRequest = serde_json::from_value(value).map_err(|_| ())?;
        if !valid_model_id(&raw.model)
            || !structured(&raw.state)
            || !(1..=20).contains(&raw.questions.len())
        {
            return Err(());
        }
        let mut questions = Vec::with_capacity(raw.questions.len());
        for (name, value) in raw.questions {
            if !value.is_object() {
                return Err(());
            }
            let question: Question = serde_json::from_value(value).map_err(|_| ())?;
            if name.trim().is_empty() || !question.valid() {
                return Err(());
            }
            questions.push((name, question));
        }
        Ok(Self {
            model: raw.model,
            state: raw.state,
            questions,
        })
    }
}

impl Question {
    fn valid(&self) -> bool {
        let has_instructions = match &self.instructions {
            Value::String(text) => !text.trim().is_empty(),
            Value::Object(map) => !map.is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => false,
        };
        has_instructions
            && match (self.kind, &self.criteria) {
                (QuestionType::Noul, None) => true,
                (QuestionType::Noul, Some(Value::Object(criteria))) => {
                    criteria.keys().all(|key| key == "true" || key == "false")
                }
                (QuestionType::Choice, Some(Value::Object(criteria))) => {
                    (1..=255).contains(&criteria.len())
                        && criteria.keys().all(|key| !key.trim().is_empty())
                }
                (QuestionType::Score, Some(Value::Array(criteria))) => {
                    (2..=10).contains(&criteria.len())
                }
                _ => false,
            }
    }
}
