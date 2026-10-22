// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SystemOne and OpenAI decisions translation; provider metadata never passes through.
use serde_json::{Map, Value, json};

use super::schema::{DecisionRequest, Question, QuestionType};
use crate::json_compat::python_json_value_no_ascii;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Protocol {
    SystemOne,
    OpenAi,
}

impl Protocol {
    pub fn parse(value: &str) -> Result<Self, ()> {
        match value {
            "systemone" => Ok(Self::SystemOne),
            "openai" => Ok(Self::OpenAi),
            _ => Err(()),
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::SystemOne => "systemone",
            Self::OpenAi => "decisions",
        }
    }
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| python_json_value_no_ascii(value))
}

pub(super) fn payload(request: &DecisionRequest, protocol: Protocol, model: &str) -> Value {
    if protocol == Protocol::SystemOne {
        let questions: Map<String, Value> = request
            .questions
            .iter()
            .map(|(name, question)| {
                (
                    name.clone(),
                    serde_json::to_value(question).expect("question serializes"),
                )
            })
            .collect();
        return json!({"model": model, "state": request.state, "questions": questions});
    }
    let questions: Vec<Value> = request.questions.iter().map(|(name, question)| {
        let instructions = match (&question.kind, &question.criteria) {
            (QuestionType::Noul, Some(Value::Object(criteria))) if !criteria.is_empty() =>
                json!({"instructions": question.instructions, "criteria": criteria}),
            _ => question.instructions.clone(),
        };
        let mut result = json!({"name": name, "type": match question.kind {
            QuestionType::Noul => "predicate", QuestionType::Choice => "choice", QuestionType::Score => "score",
        }, "instructions": text(&instructions)});
        match &question.criteria {
            Some(Value::Object(criteria)) if question.kind == QuestionType::Choice => {
                result["choices"] = criteria.iter().map(|(key, rubric)| {
                    json!({"value": key, "description": if rubric.is_null() { String::new() } else { text(rubric) }})
                }).collect();
            }
            Some(Value::Array(criteria)) if question.kind == QuestionType::Score => {
                result["levels"] = criteria.iter().enumerate().map(|(index, rubric)| {
                    json!({"label": index.to_string(), "description": text(rubric)})
                }).collect();
            }
            _ => {}
        }
        result
    }).collect();
    json!({"model": model, "input": text(&request.state), "questions": questions})
}

fn number(value: &Value, maximum: f64) -> Result<Value, ()> {
    let numeric = value.as_f64().ok_or(())?;
    if !numeric.is_finite() || !(0.0..=maximum).contains(&numeric) {
        return Err(());
    }
    Ok(value.clone())
}

fn probabilities(answer: &Value, protocol: Protocol, choices: &[String]) -> Result<Value, ()> {
    let values = &answer["probabilities"];
    let mut mapped = Map::new();
    let values = if protocol == Protocol::OpenAi {
        for item in values.as_array().ok_or(())? {
            let item = item.as_object().ok_or(())?;
            let key = match item.get("value") {
                Some(Value::String(key)) => key.clone(),
                Some(Value::Null) | None => "None".into(),
                Some(Value::Bool(true)) => "True".into(),
                Some(Value::Bool(false)) => "False".into(),
                Some(value) => value.to_string(),
            };
            if mapped
                .insert(key, item.get("probability").cloned().unwrap_or(Value::Null))
                .is_some()
            {
                return Err(());
            }
        }
        &mapped
    } else {
        values.as_object().ok_or(())?
    };
    if values.len() != choices.len() {
        return Err(());
    }
    let mut result = Map::new();
    let mut sum = 0.0;
    for key in choices {
        let value = number(values.get(key).ok_or(())?, 1.0)?;
        sum += value.as_f64().ok_or(())?;
        result.insert(key.clone(), value);
    }
    if (sum - 1.0).abs() > 0.02 {
        return Err(());
    }
    Ok(Value::Object(result))
}

fn normalize_answer(answer: &Value, question: &Question, protocol: Protocol) -> Result<Value, ()> {
    if !answer.is_object() {
        return Err(());
    }
    if protocol == Protocol::OpenAi && answer["type"] == "refusal" {
        return Ok(json!({"type": "refusal"}));
    }
    let kind = match question.kind {
        QuestionType::Noul if protocol == Protocol::OpenAi => "predicate",
        QuestionType::Noul => "noul",
        QuestionType::Choice => "choice",
        QuestionType::Score => "score",
    };
    if answer["type"] != kind {
        return Err(());
    }
    if question.kind == QuestionType::Noul {
        let field = if protocol == Protocol::OpenAi {
            "probability"
        } else {
            "noul"
        };
        return Ok(json!({"type": "noul", "noul": number(&answer[field], 1.0)?}));
    }
    let choices: Vec<String> = match question.criteria.as_ref().ok_or(())? {
        Value::Object(criteria) => criteria.keys().cloned().collect(),
        Value::Array(criteria) => (0..criteria.len()).map(|index| index.to_string()).collect(),
        _ => return Err(()),
    };
    let mut result = json!({"type": kind, "confidence": number(&answer["confidence"], 1.0)?,
        "probabilities": probabilities(answer, protocol, &choices)?});
    if question.kind == QuestionType::Choice {
        let choice = answer["choice"].as_str().ok_or(())?;
        if !choices.iter().any(|key| key == choice) {
            return Err(());
        }
        result["choice"] = json!(choice);
    } else {
        result["score"] = number(&answer["score"], (choices.len() - 1) as f64)?;
        let criteria = question
            .criteria
            .as_ref()
            .and_then(Value::as_array)
            .ok_or(())?;
        result["legend"] = Value::Object(
            criteria
                .iter()
                .enumerate()
                .map(|(index, rubric)| (index.to_string(), json!(text(rubric))))
                .collect(),
        );
    }
    Ok(result)
}

pub(super) fn normalize(
    value: &Value,
    request: &DecisionRequest,
    protocol: Protocol,
) -> Result<Value, ()> {
    let value = value.as_object().ok_or(())?;
    let answers = value.get("answers").ok_or(())?;
    let mut mapped = Map::new();
    let answers = if protocol == Protocol::OpenAi {
        for answer in answers.as_array().ok_or(())? {
            let name = answer.get("name").and_then(Value::as_str).ok_or(())?;
            if mapped.insert(name.to_owned(), answer.clone()).is_some() {
                return Err(());
            }
        }
        &mapped
    } else {
        answers.as_object().ok_or(())?
    };
    if answers.len() != request.questions.len() {
        return Err(());
    }
    let mut result_answers = Map::new();
    for (name, question) in &request.questions {
        result_answers.insert(
            name.clone(),
            normalize_answer(answers.get(name).ok_or(())?, question, protocol)?,
        );
    }
    let mut result = json!({"model": request.model, "answers": result_answers});
    if let Some(usage) = value.get("usage").and_then(Value::as_object) {
        result["usage"] = Value::Object(
            ["input_tokens", "output_tokens", "total_tokens"]
                .into_iter()
                .filter_map(|key| {
                    usage
                        .get(key)
                        .filter(|value| value.as_u64().is_some())
                        .map(|value| (key.to_owned(), value.clone()))
                })
                .collect(),
        );
    }
    Ok(result)
}
