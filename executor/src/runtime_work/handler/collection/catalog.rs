// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn collect_links(
        &self,
        archived: bool,
    ) -> Vec<RuntimeTaskLink> {
        self.collect_links_catalog(archived, Some(CODEX_THREAD_LIST_MAX_ITEMS))
            .await
            .0
    }

    pub(in crate::runtime_work::handler) async fn collect_query_links(
        &self,
        archived: bool,
    ) -> (Vec<RuntimeTaskLink>, bool) {
        self.collect_links_catalog(archived, None).await
    }

    async fn collect_links_catalog(
        &self,
        archived: bool,
        limit: Option<usize>,
    ) -> (Vec<RuntimeTaskLink>, bool) {
        let started_at = Instant::now();
        let mut links = Vec::new();
        let mut discovered_thread_ids = HashSet::new();
        let mut discovered_local_task_ids = HashSet::new();

        let (threads, mut complete) = self.read_codex_catalog(archived, limit).await;
        let stage_started_at = Instant::now();
        let closed_threads: HashSet<_> = self
            .local_task_links(true)
            .iter()
            .flat_map(|link| {
                crate::runtime_work::conversation_sessions::closed_sessions(link)
                    .unwrap_or_default()
            })
            .map(|session| session.thread_id)
            .collect();
        for thread in threads {
            if string_field(&thread, "id").is_some_and(|id| closed_threads.contains(&id)) {
                continue;
            }
            let thread_started_at = Instant::now();
            let thread_id = string_field(&thread, "id").unwrap_or_else(|| "none".to_owned());
            if let Some(mut link) = self.link_from_thread(&thread) {
                log_slow_runtime_collect_thread(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                    &link,
                );
                if link.ephemeral
                    || (link.runtime_handle["origin"]["type"] == "stand_in_coordinator"
                        && link.interaction_status.is_none())
                {
                    continue;
                }
                if self.archived_link_is_deleted(&link) {
                    log_executor_event(
                        "runtime work codex link hidden by deleted marker",
                        &[
                            ("archived_query", archived.to_string()),
                            ("local_task_id", link.local_task_id.clone()),
                            (
                                "thread_id",
                                link.thread_id.as_deref().unwrap_or("none").to_owned(),
                            ),
                            ("workspace_path", link.workspace_path.clone()),
                        ],
                    );
                    continue;
                }
                if archived {
                    link.status = "archived".to_owned();
                    link.running = false;
                    link.continuable = false;
                } else if link.status == "archived" {
                    continue;
                }
                link.list_order = Some(links.len());
                if let Some(thread_id) = &link.thread_id {
                    discovered_thread_ids.insert(thread_id.clone());
                }
                discovered_local_task_ids.insert(link.local_task_id.clone());
                links.push(link);
            } else {
                complete = false;
                log_slow_runtime_collect_thread_missing(
                    archived,
                    &thread_id,
                    thread_started_at,
                    &thread,
                );
            }
        }
        log_runtime_collect_diagnostic(
            "threads_linked",
            archived,
            started_at,
            stage_started_at,
            &[
                ("links", links.len().to_string()),
                ("threads", discovered_thread_ids.len().to_string()),
            ],
        );

        self.merge_local_task_links(
            archived,
            &mut links,
            &discovered_thread_ids,
            &discovered_local_task_ids,
            started_at,
        );

        (links, complete)
    }

    pub(in crate::runtime_work::handler) fn collect_cached_links(
        &self,
        archived: bool,
    ) -> Vec<RuntimeTaskLink> {
        let started_at = Instant::now();
        let mut links = Vec::new();
        self.merge_local_task_links(
            archived,
            &mut links,
            &HashSet::new(),
            &HashSet::new(),
            started_at,
        );
        links
    }

    fn merge_local_task_links(
        &self,
        archived: bool,
        links: &mut Vec<RuntimeTaskLink>,
        discovered_thread_ids: &HashSet<String>,
        discovered_local_task_ids: &HashSet<String>,
        started_at: Instant,
    ) {
        let stage_started_at = Instant::now();
        for mut link in self.local_task_links(true) {
            if self.archived_link_is_deleted(&link) {
                continue;
            }
            if link.ephemeral
                || (link.runtime_handle["origin"]["type"] == "stand_in_coordinator"
                    && link.interaction_status.is_none())
            {
                continue;
            }
            let link_archived = link.status == "archived";
            if link_archived != archived {
                continue;
            }
            if is_cached_codex_link_hidden(&link, discovered_thread_ids) {
                continue;
            }
            if discovered_local_task_ids.contains(&link.local_task_id) {
                continue;
            }
            if link
                .thread_id
                .as_ref()
                .is_some_and(|thread_id| discovered_thread_ids.contains(thread_id))
            {
                continue;
            }
            let running = self.is_active_local_task(&link.local_task_id);
            let queue_position = self.queued_local_task_position(&link.local_task_id);
            apply_local_execution_state(&mut link, running, queue_position);
            link.list_order = Some(links.len());
            links.push(link);
        }
        log_runtime_collect_diagnostic(
            "local_links_merged",
            archived,
            started_at,
            stage_started_at,
            &[("links", links.len().to_string())],
        );
    }

    async fn read_codex_catalog(&self, archived: bool, limit: Option<usize>) -> (Vec<Value>, bool) {
        let started_at = Instant::now();
        let mut threads = Vec::new();
        let mut cursor = None;
        let mut pages = 0_usize;
        let mut complete = true;
        let mut seen_cursors = HashSet::new();
        self.ensure_notification_router().await;
        loop {
            let params = codex_thread_list_params(archived, cursor.as_deref());
            let response = match self.codex_app_server.request("thread/list", params).await {
                Ok(response) => response,
                Err(error) => {
                    complete = false;
                    log_executor_event(
                        "runtime work thread list failed",
                        &[
                            ("elapsed_ms", elapsed_ms(started_at)),
                            ("archived", archived.to_string()),
                            ("threads", threads.len().to_string()),
                            ("pages", pages.to_string()),
                            ("error", error),
                        ],
                    );
                    break;
                }
            };
            let Some(data) = response.get("data").and_then(Value::as_array) else {
                complete = false;
                log_executor_event(
                    "runtime work thread list malformed",
                    &[
                        ("elapsed_ms", elapsed_ms(started_at)),
                        ("archived", archived.to_string()),
                        ("threads", threads.len().to_string()),
                        ("pages", pages.to_string()),
                        ("error", "missing data array".to_owned()),
                    ],
                );
                break;
            };
            pages += 1;
            threads.extend(data.iter().cloned());
            cursor = string_field(&response, "nextCursor");
            if cursor.is_none() {
                break;
            }
            if limit.is_some_and(|limit| threads.len() >= limit)
                || !seen_cursors.insert(cursor.clone())
            {
                complete = false;
                break;
            }
        }

        if let Some(limit) = limit {
            threads.truncate(limit);
        }
        log_executor_event(
            "runtime work thread list fetched",
            &[
                ("elapsed_ms", elapsed_ms(started_at)),
                ("archived", archived.to_string()),
                ("threads", threads.len().to_string()),
                ("pages", pages.to_string()),
                ("truncated", (!complete).to_string()),
            ],
        );
        (threads, complete)
    }

    pub(in crate::runtime_work::handler) fn visible_links_for_projects(
        &self,
        links: Vec<RuntimeTaskLink>,
        project_index: &CodexGlobalProjectIndex,
    ) -> Vec<RuntimeTaskLink> {
        let mut links = links
            .into_iter()
            .map(|mut link| {
                if !is_codex_runtime(&link.runtime) {
                    return link;
                }

                if let Some(thread_id) = link.thread_id.as_deref() {
                    link.pinned = project_index.is_pinned_thread(thread_id);
                    link.pinned_order = project_index.pinned_thread_order(thread_id);
                }
                link
            })
            .collect::<Vec<_>>();
        let input_count = links.len();
        let project_count = project_index.projects().len();
        let project_roots = project_index
            .projects()
            .iter()
            .map(|project| project.workspace_path.as_str())
            .collect::<Vec<_>>()
            .join("|");

        if !project_index.has_projects() && !project_index.has_project_state() {
            self.apply_manual_project_thread_orders(&mut links, project_index);
            log_executor_event(
                "runtime work project filter skipped",
                &[
                    ("reason", "no_project_state".to_owned()),
                    ("input_links", input_count.to_string()),
                    ("project_count", project_count.to_string()),
                    (
                        "project_state_loaded",
                        project_index.has_project_state().to_string(),
                    ),
                ],
            );
            return links;
        }

        let mut visible_links = Vec::with_capacity(input_count);
        let mut kept_chat = 0_usize;
        let mut kept_project = 0_usize;
        let mut filtered_projectless = 0_usize;
        let mut filtered_no_project = 0_usize;

        for mut link in links {
            // Sidebar assignments override creation bindings without changing execution state.
            let assigned_project = link
                .thread_id
                .as_deref()
                .filter(|id| !project_index.is_projectless_thread(id))
                .and_then(|id| project_index.sidebar_project_key_for_thread(id))
                .and_then(|key| project_index.project_for_key(key));
            if let Some(project) = assigned_project {
                let source_project = link
                    .runtime_project_key
                    .as_deref()
                    .and_then(|key| project_index.project_for_key(key))
                    .or_else(|| project_index.project_for_path(&link.workspace_path));
                link.preserve_execution_path = source_project
                    .map(|source| source.key != project.key)
                    .unwrap_or(true);
                link.group_workspace_path = Some(project.workspace_path.clone());
                link.group_project_key = Some(project.key.clone());
                kept_project += 1;
                visible_links.push(link);
                continue;
            }
            let workspace_kind = link.workspace_kind();
            if workspace_kind == "chat" {
                kept_chat += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "keep",
                        reason: "chat_workspace",
                        workspace_kind,
                        group_path: None,
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint: None,
                        project_count,
                    },
                );
                visible_links.push(link);
                continue;
            }

            let group_path = self
                .worktrees
                .source_path_for(&link.workspace_path)
                .unwrap_or_else(|| workspace_group_path(&link.workspace_path));
            let thread_id = link.thread_id.as_deref();
            let thread_hint = thread_id.and_then(|id| project_index.thread_workspace_hint(id));
            if thread_id.is_some_and(|id| project_index.is_projectless_thread(id)) {
                filtered_projectless += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "projectless_thread",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            }

            let explicit_project = link
                .runtime_project_key
                .as_deref()
                .and_then(|project_key| project_index.project_for_key(project_key));
            let direct_project = explicit_project
                .or_else(|| project_index.project_for_thread(thread_id, &link.workspace_path));
            let group_project = if direct_project.is_none() {
                project_index.project_for_thread(thread_id, &group_path)
            } else {
                None
            };
            let project = direct_project.or(group_project);

            let Some(project) = project else {
                filtered_no_project += 1;
                log_runtime_project_filter_item(
                    &link,
                    RuntimeProjectFilterLog {
                        action: "filter",
                        reason: "no_matching_project",
                        workspace_kind,
                        group_path: Some(&group_path),
                        matched_by: None,
                        project_workspace_path: None,
                        project_name: None,
                        thread_hint,
                        project_count,
                    },
                );
                continue;
            };

            let matched_by = if let Some(hinted_root) = thread_hint {
                if project_index
                    .project_for_key(hinted_root)
                    .is_some_and(|hinted_project| {
                        hinted_project.workspace_path == project.workspace_path
                    })
                {
                    "thread_hint"
                } else if direct_project.is_some() {
                    "workspace_path"
                } else {
                    "group_path"
                }
            } else if direct_project.is_some() {
                "workspace_path"
            } else {
                "group_path"
            };
            let project_workspace_path = project.workspace_path.clone();
            let project_key = project.key.clone();
            let project_name = project.name.clone();
            link.group_workspace_path = Some(project_workspace_path.clone());
            link.group_project_key = Some(project_key.clone());
            kept_project += 1;
            log_runtime_project_filter_item(
                &link,
                RuntimeProjectFilterLog {
                    action: "keep",
                    reason: "matched_project",
                    workspace_kind,
                    group_path: Some(&group_path),
                    matched_by: Some(matched_by),
                    project_workspace_path: Some(&project_workspace_path),
                    project_name: Some(&project_name),
                    thread_hint,
                    project_count,
                },
            );
            visible_links.push(link);
        }

        log_executor_event(
            "runtime work project filter finished",
            &[
                ("input_links", input_count.to_string()),
                ("visible_links", visible_links.len().to_string()),
                (
                    "filtered_links",
                    (filtered_projectless + filtered_no_project).to_string(),
                ),
                ("project_count", project_count.to_string()),
                (
                    "project_state_loaded",
                    project_index.has_project_state().to_string(),
                ),
                ("project_roots", project_roots),
                ("kept_chat", kept_chat.to_string()),
                ("kept_project", kept_project.to_string()),
                ("filtered_projectless", filtered_projectless.to_string()),
                ("filtered_no_project", filtered_no_project.to_string()),
            ],
        );

        self.apply_manual_project_thread_orders(&mut visible_links, project_index);
        visible_links
    }

    fn apply_manual_project_thread_orders(
        &self,
        links: &mut [RuntimeTaskLink],
        project_index: &CodexGlobalProjectIndex,
    ) {
        struct ManualProjectTaskGroups {
            unlisted: Vec<usize>,
            listed: Vec<usize>,
        }

        let mut groups = HashMap::<String, ManualProjectTaskGroups>::new();
        for (index, link) in links.iter().enumerate() {
            if !is_codex_runtime(&link.runtime) {
                continue;
            }
            let Some(thread_id) = link.thread_id.as_deref() else {
                continue;
            };
            let project_key = runtime_task_sidebar_project_key(link, project_index);
            if !project_index.has_manual_thread_order(&project_key) {
                continue;
            }

            let group =
                groups
                    .entry(project_key.clone())
                    .or_insert_with(|| ManualProjectTaskGroups {
                        unlisted: Vec::new(),
                        listed: Vec::new(),
                    });
            if project_index.is_thread_in_manual_order(&project_key, thread_id) {
                group.listed.push(index);
            } else {
                group.unlisted.push(index);
            }
        }

        for (project_key, mut group) in groups {
            group.listed.sort_by(|left, right| {
                let left_thread = links[*left].thread_id.as_deref().unwrap_or("");
                let right_thread = links[*right].thread_id.as_deref().unwrap_or("");
                project_index
                    .thread_sort_order(&project_key, left_thread, 0)
                    .cmp(&project_index.thread_sort_order(&project_key, right_thread, 0))
            });
            group.unlisted.sort_by(|left, right| {
                compare_unlisted_manual_project_links(&links[*left], &links[*right])
            });

            for (sidebar_order, index) in group.listed.iter().enumerate() {
                links[*index].sidebar_order = Some(sidebar_order);
            }
            let ordered_indices = group.unlisted.into_iter().chain(group.listed);
            for (next_order, index) in ordered_indices.enumerate() {
                links[index].list_order = Some(next_order);
            }
        }
    }
}

fn runtime_task_sidebar_project_key(
    link: &RuntimeTaskLink,
    project_index: &CodexGlobalProjectIndex,
) -> String {
    if let Some(project_key) = link
        .group_project_key
        .as_deref()
        .filter(|project_key| !project_key.trim().is_empty())
    {
        return project_key.to_owned();
    }
    if let Some(project_key) = link
        .thread_id
        .as_deref()
        .and_then(|thread_id| project_index.sidebar_project_key_for_thread(thread_id))
    {
        return project_key.to_owned();
    }
    if let Some(project_key) = link
        .runtime_project_key
        .as_deref()
        .filter(|project_key| !project_key.trim().is_empty())
    {
        return project_key.to_owned();
    }
    if let Some(workspace_path) = link
        .group_workspace_path
        .as_deref()
        .filter(|workspace_path| !workspace_path.trim().is_empty())
    {
        return format!("local:{workspace_path}");
    }
    if link.workspace_kind() == "chat" {
        return "chats".to_owned();
    }
    format!("local:{}", workspace_group_path(&link.workspace_path))
}

fn compare_unlisted_manual_project_links(
    left: &RuntimeTaskLink,
    right: &RuntimeTaskLink,
) -> std::cmp::Ordering {
    right
        .updated_at
        .cmp(&left.updated_at)
        .then_with(|| right.created_at.cmp(&left.created_at))
        .then_with(|| left.local_task_id.cmp(&right.local_task_id))
}

#[cfg(test)]
mod tests;
