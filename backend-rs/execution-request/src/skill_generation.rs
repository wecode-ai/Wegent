// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The generation-context hook the create flow runs around skill resolution
//! (`app/services/execution/skill_generation.py`).
//!
//! `enrich_skill_generation_context` applies every registered context enricher
//! in registration order to the request's generation value and the attachments
//! the flow fetched for it; `apply_skill_generation_to_skills` then lets the
//! registered injectors write that value into the resolved skill entries.
//!
//! Deployments register their own media enrichment and skill injection hooks.
//! With no registered hooks, both steps preserve their input.
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::contexts::SubtaskContextRow;

/// One registered generation context enricher: `(generation, current
/// attachments, task attachments, current subtask id, user id) -> generation`.
pub type GenerationContextEnricher =
    fn(Option<&Value>, &[SubtaskContextRow], &[SubtaskContextRow], i64, i64) -> Option<Value>;

/// One registered skill generation injector: `(skills, team owner id,
/// generation, prompt)`.
pub type SkillGenerationInjector = fn(&mut [Value], i64, Option<&Value>, Option<&str>);

fn context_enrichers() -> &'static Mutex<Vec<GenerationContextEnricher>> {
    static ENRICHERS: OnceLock<Mutex<Vec<GenerationContextEnricher>>> = OnceLock::new();
    ENRICHERS.get_or_init(|| Mutex::new(Vec::new()))
}

fn skill_injectors() -> &'static Mutex<Vec<SkillGenerationInjector>> {
    static INJECTORS: OnceLock<Mutex<Vec<SkillGenerationInjector>>> = OnceLock::new();
    INJECTORS.get_or_init(|| Mutex::new(Vec::new()))
}

/// `register_skill_generation_context_enricher`.
pub fn register_skill_generation_context_enricher(enricher: GenerationContextEnricher) {
    context_enrichers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(enricher);
}

/// `register_skill_generation_injector`.
pub fn register_skill_generation_injector(injector: SkillGenerationInjector) {
    skill_injectors()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(injector);
}

/// `enrich_skill_generation_context` (`skill_generation.py:53-68`): apply the
/// registered enrichers in registration order. The attachment rows are the
/// enricher inputs, so a caller must pass the ones it fetched.
pub fn enrich_skill_generation_context(
    generation: Option<&Value>,
    current_attachments: &[SubtaskContextRow],
    task_attachments: &[SubtaskContextRow],
    current_subtask_id: i64,
    user_id: i64,
) -> Option<Value> {
    let mut enriched = generation.cloned();
    for enricher in context_enrichers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
    {
        enriched = enricher(
            enriched.as_ref(),
            current_attachments,
            task_attachments,
            current_subtask_id,
            user_id,
        );
    }
    enriched
}

/// `apply_skill_generation_to_skills` (`skill_generation.py:80-99`): let the
/// registered injectors write the generation value into the resolved skills.
pub fn apply_skill_generation_to_skills(
    skills: &mut [Value],
    team_user_id: i64,
    generation: Option<&Value>,
    prompt: Option<&str>,
) {
    for injector in skill_injectors()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
    {
        injector(skills, team_user_id, generation, prompt);
    }
}
