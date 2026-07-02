// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::protocol::ExecutionRequest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRef {
    pub skill_id: i64,
    pub namespace: String,
    pub is_public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDeploymentOptions {
    pub skills_dir: PathBuf,
    pub clear_cache: bool,
    pub skip_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDeploymentPlan {
    pub skills: Vec<String>,
    pub auth_token: String,
    pub team_namespace: String,
    pub task_id: Option<i64>,
    pub skills_dir: PathBuf,
    pub clear_cache: bool,
    pub skip_existing: bool,
    pub resolved_skill_map: BTreeMap<String, SkillRef>,
}

const INTERACTIVE_SKILL_NAME: &str = "interactive";
const INTERACTIVE_FORM_QUESTION_ALIAS: &str = "interactive-form-question";
const INTERACTIVE_FORM_TOOL_ALIAS: &str = "interactive_form_question";
const INTERACTIVE_RUNTIME_ALIASES: &[&str] = &[INTERACTIVE_FORM_QUESTION_ALIAS];
const INTERACTIVE_FORM_ALIAS_SKILL_MD: &str = r#"---
name: "interactive-form-question"
description: "Compatibility alias for Wegent's interactive skill. Use this when older prompts ask for interactive-form-question to collect user input via interactive_form_question."
displayName: "Interactive Form Question"
version: "2.0.0"
author: "Wegent Team"
tags: ["interaction", "user-input", "form", "clarification", "compatibility"]
---

# Interactive Form Question

This is a compatibility alias for the `interactive` skill.

Use the already configured `interactive_form_question` tool to ask the user questions through an interactive form. Do not write questions, options, or choice lists as plain text when the form tool is available.
"#;

pub fn canonical_skill_name(skill_name: &str) -> &str {
    match skill_name.trim() {
        INTERACTIVE_FORM_QUESTION_ALIAS | INTERACTIVE_FORM_TOOL_ALIAS => INTERACTIVE_SKILL_NAME,
        value => value,
    }
}

pub fn ensure_runtime_skill_aliases(
    skills_dir: &Path,
    skills: &[String],
) -> Result<Vec<String>, String> {
    let mut created_or_existing = Vec::new();

    for skill in skills {
        for alias in runtime_aliases_for_skill(skill) {
            let canonical = canonical_skill_name(skill);
            if !skills_dir.join(canonical).join("SKILL.md").is_file() {
                continue;
            }

            let alias_dir = skills_dir.join(alias);
            let alias_skill_md = alias_dir.join("SKILL.md");
            if alias_skill_md.is_file() {
                created_or_existing.push((*alias).to_owned());
                continue;
            }
            if alias_dir.exists() && !alias_dir.is_dir() {
                return Err(format!(
                    "skill alias path is not a directory: {}",
                    alias_dir.display()
                ));
            }
            fs::create_dir_all(&alias_dir).map_err(|error| {
                format!(
                    "failed to create skill alias dir {}: {error}",
                    alias_dir.display()
                )
            })?;
            fs::write(&alias_skill_md, INTERACTIVE_FORM_ALIAS_SKILL_MD).map_err(|error| {
                format!(
                    "failed to write skill alias {}: {error}",
                    alias_skill_md.display()
                )
            })?;
            created_or_existing.push((*alias).to_owned());
        }
    }

    Ok(created_or_existing)
}

fn runtime_aliases_for_skill(skill_name: &str) -> &'static [&'static str] {
    match canonical_skill_name(skill_name) {
        INTERACTIVE_SKILL_NAME => INTERACTIVE_RUNTIME_ALIASES,
        _ => &[],
    }
}

pub fn resolve_skill_download_map(
    skills: &[String],
    preload_skills: &[String],
    skill_configs: &[Value],
    skill_refs: &BTreeMap<String, Value>,
    preload_skill_refs: &BTreeMap<String, Value>,
) -> BTreeMap<String, SkillRef> {
    let config_map = skill_config_map(skill_configs);
    let mut resolved = BTreeMap::new();

    for name in skills {
        if let Some(skill_ref) = preload_skill_refs
            .get(name)
            .and_then(skill_ref_from_value)
            .or_else(|| skill_refs.get(name).and_then(skill_ref_from_value))
            .or_else(|| config_map.get(name).cloned())
        {
            resolved.insert(name.clone(), skill_ref);
        }
    }

    for name in preload_skills {
        if let Some(skill_ref) = preload_skill_refs
            .get(name)
            .and_then(skill_ref_from_value)
            .or_else(|| {
                (!resolved.contains_key(name))
                    .then(|| skill_refs.get(name).and_then(skill_ref_from_value))
                    .flatten()
            })
            .or_else(|| {
                (!resolved.contains_key(name))
                    .then(|| config_map.get(name).cloned())
                    .flatten()
            })
        {
            resolved.insert(name.clone(), skill_ref);
        }
    }

    resolved
}

pub fn collect_skill_names_for_deployment(
    bot_config: &Value,
    request: &ExecutionRequest,
) -> Vec<String> {
    let mut names = Vec::new();
    add_skill_names(&mut names, bot_config.get("skills"));

    if request_mode(request).is_some_and(|mode| mode == "coordinate") {
        if let Some(bots) = request.bot.as_array() {
            for bot in bots {
                add_skill_names(&mut names, bot.get("skills"));
            }
        }
    }

    add_skill_names(&mut names, request.extra.get("skill_names"));
    add_skill_names(&mut names, request.extra.get("preload_skills"));
    names
}

pub fn build_skill_emphasis_prompt(user_selected_skills: &[String]) -> String {
    if user_selected_skills.is_empty() {
        return String::new();
    }

    let skill_list = user_selected_skills
        .iter()
        .map(|skill| format!("  - **{skill}** [USER SELECTED - PRIORITIZE]"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut prompt = format!(
        "## User-Selected Skills\n\n\
The user has explicitly selected the following skills for this task. You should **prioritize using these skills** when they are relevant to the task:\n\n\
{skill_list}\n\n\
**Important**: These skills were specifically chosen by the user. When the task can benefit from these skills, prefer to use them over other approaches.\n\n\
---\n\n"
    );

    if user_selected_skills
        .iter()
        .any(|skill| skill == "wegent-knowledge")
    {
        prompt.push_str(
            "## Selected Knowledge Base Priority\n\n\
The user explicitly selected the Wegent knowledge-base skill for this request.\n\
When selected knowledge bases are present:\n\
- Use the selected knowledge bases as the primary source for request content.\n\
- Use Wegent knowledge tools before web search or other external lookup.\n\
- Only fall back to web search when the user explicitly asks for external or current web information, or when the selected knowledge bases cannot answer the request.\n\n\
---\n\n",
        );
    }

    prompt
}

pub fn build_skill_deployment_plan(
    bot_config: &Value,
    request: &ExecutionRequest,
    options: SkillDeploymentOptions,
) -> Option<SkillDeploymentPlan> {
    let skills = collect_skill_names_for_deployment(bot_config, request);
    if skills.is_empty() {
        return None;
    }

    let auth_token = request
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_owned();
    let team_namespace = request
        .team_namespace
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "default".to_owned());
    let preload_skills = string_array(request.extra.get("preload_skills"));
    let skill_configs = value_array(request.extra.get("skill_configs"));
    let mut skill_refs = value_object_map(bot_config.get("skill_refs"));
    skill_refs.extend(value_object_map(request.extra.get("skill_refs")));
    let mut preload_skill_refs = value_object_map(bot_config.get("preload_skill_refs"));
    preload_skill_refs.extend(value_object_map(request.extra.get("preload_skill_refs")));
    let resolved_skill_map = resolve_skill_download_map(
        &skills,
        &preload_skills,
        &skill_configs,
        &skill_refs,
        &preload_skill_refs,
    );

    Some(SkillDeploymentPlan {
        skills,
        auth_token,
        team_namespace,
        task_id: (request.task_id > 0).then_some(request.task_id),
        skills_dir: options.skills_dir,
        clear_cache: options.clear_cache,
        skip_existing: options.skip_existing,
        resolved_skill_map,
    })
}

fn skill_config_map(skill_configs: &[Value]) -> BTreeMap<String, SkillRef> {
    let mut map = BTreeMap::new();
    for config in skill_configs {
        let Some(name) = config.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(skill_ref) = skill_ref_from_value(config) else {
            continue;
        };
        map.insert(canonical_skill_name(name).to_owned(), skill_ref);
    }
    map
}

fn skill_ref_from_value(value: &Value) -> Option<SkillRef> {
    let skill_id = value_i64(value.get("skill_id"))?;
    let namespace = value
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    let is_public = value
        .get("is_public")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(SkillRef {
        skill_id,
        namespace,
        is_public,
    })
}

fn add_skill_names(names: &mut Vec<String>, value: Option<&Value>) {
    for name in string_array(value) {
        let canonical = canonical_skill_name(&name).to_owned();
        if !names.contains(&canonical) {
            names.push(canonical);
        }
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn value_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn value_object_map(value: Option<&Value>) -> BTreeMap<String, Value> {
    let Some(object) = value.and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    object
        .iter()
        .map(|(key, value)| (canonical_skill_name(key).to_owned(), value.clone()))
        .collect()
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
    })
}

fn request_mode(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}
