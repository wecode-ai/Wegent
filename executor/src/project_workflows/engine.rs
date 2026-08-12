// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use super::{ConfigurationValidation, RepositoryInput, SquadInput, WorkflowInput};

pub fn validate_squad(input: &SquadInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Robot squad name is required".to_owned());
    }
    let members = input.member_agent_ids.iter().collect::<HashSet<&String>>();
    if members.len() != input.member_agent_ids.len() {
        return Err("Robot squad members must be unique".to_owned());
    }
    if !members.contains(&input.leader_agent_id) {
        return Err("Robot squad leader must be a member".to_owned());
    }
    if !(1..=20).contains(&input.max_parallel_members) {
        return Err("Robot squad parallel members must be between 1 and 20".to_owned());
    }
    Ok(())
}

pub fn validate_repository(input: &RepositoryInput) -> ConfigurationValidation {
    let mut issues = Vec::new();
    if !matches!(input.provider.as_str(), "github" | "gitlab" | "generic") {
        issues.push("Repository provider must be github, gitlab, or generic".to_owned());
    }
    if input.repository_identity.trim().is_empty() {
        issues.push("Repository identity is required".to_owned());
    }
    if input.repository_url.trim().is_empty() {
        issues.push("Repository URL is required".to_owned());
    }
    if input.default_branch.trim().is_empty() {
        issues.push("Default branch is required".to_owned());
    }
    ConfigurationValidation {
        valid: issues.is_empty(),
        issues,
    }
}

pub fn validate_workflow(input: &WorkflowInput) -> ConfigurationValidation {
    let mut issues = Vec::new();
    if input.name.trim().is_empty() {
        issues.push("Workflow name is required".to_owned());
    }
    if input.stages.is_empty() {
        issues.push("Workflow requires at least one stage group".to_owned());
    }
    let mut group_keys = HashSet::new();
    let mut has_complete = false;
    for group in &input.stages {
        if !group_keys.insert(group.key.as_str()) {
            issues.push(format!("Duplicate stage group key: {}", group.key));
        }
        if group.nodes.is_empty() {
            issues.push(format!(
                "Stage group {} requires at least one node",
                group.key
            ));
        }
        let mut node_keys = HashSet::new();
        for node in &group.nodes {
            if !node_keys.insert(node.key.as_str()) {
                issues.push(format!(
                    "Duplicate node key in stage group {}: {}",
                    group.key, node.key
                ));
            }
            if node.node_type == "agent" && node.actor.is_none() {
                issues.push(format!("Agent node {} requires an actor", node.key));
            }
            if node.node_type != "agent" && node.actor.is_some() {
                issues.push(format!("Platform node {} cannot have an actor", node.key));
            }
            if node.node_type == "complete" {
                has_complete = true;
            }
        }
    }
    if !has_complete {
        issues.push("Workflow requires a complete node".to_owned());
    }
    ConfigurationValidation {
        valid: issues.is_empty(),
        issues,
    }
}
