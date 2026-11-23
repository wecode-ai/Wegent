//! Explicit subscription Skill references reuse the execution Skill compiler.
use super::*;
use std::collections::HashMap;

#[allow(clippy::too_many_arguments)]
pub async fn append_requested_skills<M: Mysql, T: UserMcpAccessTokens>(
    mysql: &M,
    result: &mut BotSkills,
    references: &[Value],
    user: i64,
    user_preferences: Option<&str>,
    tokens: &T,
    team_namespace: &str,
    access: Option<&SkillAccess<'_>>,
) -> Result<(), FastApiError> {
    // `existing_skill_names` (`request_builder.py:1709,1719,1797`): Ghost
    // Skills plus this stage's resolved ones. The available stage runs after
    // this one (`:1814`), so a binding-only Skill is not here yet.
    let mut existing: Vec<String> = std::mem::take(&mut result.existing_skill_names);
    for reference in references {
        let Some(reference) = RequestedSkillRef::parse(reference) else {
            continue;
        };
        let name = reference.name;
        let skill = find_skill_by_ref(mysql, &reference, user, team_namespace)
            .await
            .map_err(super::dependency)?;
        let ghost_resolved = existing.iter().any(|existing| existing == name);
        match requested_skill_outcome(ghost_resolved, skill.is_some()) {
            RequestedSkillOutcome::Skipped => continue,
            RequestedSkillOutcome::Preloaded => record_requested_skill(result, name),
            RequestedSkillOutcome::Resolved => {
                let Some(skill) = skill else {
                    continue;
                };
                if let Some(access) = access
                    && !access
                        .can_user_access_skill(user, &skill)
                        .await
                        .map_err(super::dependency)?
                {
                    continue;
                }
                if !ghost_resolved {
                    // `_get_bot_skills` resolves the caller's preloaded Skills
                    // between the Ghost's and the injected available ones, so a
                    // requested entry lands at the Ghost boundary instead of
                    // after the available entries already resolved. A name the
                    // available pass already resolved is superseded here: the
                    // source's available loop skips it afterwards
                    // (`request_builder.py:1826`), so only this resolution
                    // stays in the Skill list.
                    result.skills.retain(|entry| entry["name"] != name);
                    let at = result.preload_insert_at.min(result.skills.len());
                    result.skills.insert(
                        at,
                        build_skill_data_with_oauth(&skill, user_preferences, tokens).await?,
                    );
                    result.preload_insert_at = at + 1;
                }
                result.skill_refs.insert(
                    name.into(),
                    serde_json::to_value(SkillRefMeta::from_kind(&skill)).unwrap_or(Value::Null),
                );
                existing.push(name.to_string());
                record_requested_skill(result, name);
            }
        }
    }
    result.existing_skill_names = existing;
    Ok(())
}

/// `_get_bot_skills`' requested-Skill branch (`request_builder.py:1755-1810`).
#[derive(Debug, PartialEq, Eq)]
enum RequestedSkillOutcome {
    /// A row resolved: insert the Skill, its ref, and the name.
    Resolved,
    /// No row but a Ghost Skill: keep the name preloaded.
    Preloaded,
    /// No row and no Ghost Skill: the source adds nothing.
    Skipped,
}

fn requested_skill_outcome(ghost_resolved: bool, resolved: bool) -> RequestedSkillOutcome {
    match (resolved, ghost_resolved) {
        (true, _) => RequestedSkillOutcome::Resolved,
        (false, true) => RequestedSkillOutcome::Preloaded,
        (false, false) => RequestedSkillOutcome::Skipped,
    }
}

/// Add a preloaded name to both lists (`request_builder.py:1788-1804`).
fn record_requested_skill(result: &mut BotSkills, name: &str) {
    for names in [&mut result.preload_skills, &mut result.user_selected_skills] {
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
}

/// `preload_skill_refs` (`request_builder.py:920-924`): resolved preload names
/// only, so a missed lookup never appears here.
pub fn preload_skill_refs(result: &BotSkills) -> Value {
    Value::Object(
        result
            .preload_skills
            .iter()
            .filter_map(|name| {
                result
                    .skill_refs
                    .get(name)
                    .map(|reference| (name.clone(), reference.clone()))
            })
            .collect(),
    )
}

/// One `_get_bot_skills` requested Skill (`request_builder.py:366-383`): a bare
/// request name is `{"name": name}` — personal `default`, non-public.
struct RequestedSkillRef<'a> {
    name: &'a str,
    namespace: &'a str,
    is_public: bool,
    skill_id: Option<i64>,
}

impl<'a> RequestedSkillRef<'a> {
    fn parse(reference: &'a Value) -> Option<Self> {
        if let Some(name) = reference.as_str() {
            return (!name.is_empty()).then_some(Self {
                name,
                namespace: "default",
                is_public: false,
                skill_id: None,
            });
        }
        let name = reference["name"].as_str().filter(|name| !name.is_empty())?;
        Some(Self {
            name,
            namespace: reference["namespace"].as_str().unwrap_or("default"),
            is_public: reference["is_public"] == true,
            skill_id: reference["skill_id"].as_i64(),
        })
    }
}

/// `find_skill_by_ref` (`skill_resolution.py:116-233`): the explicit id
/// first, then the public branch, then the personal/namespace/team lookups in
/// the source's order. Every branch is its own recorded read, so the
/// predicate order and the parameter order are part of the contract.
async fn find_skill_by_ref<M: Mysql>(
    mysql: &M,
    reference: &RequestedSkillRef<'_>,
    user: i64,
    team_namespace: &str,
) -> MysqlResult<Option<SkillKindRow>> {
    let name = reference.name.to_string();
    if let Some(skill_id) = reference.skill_id {
        return mysql
            .fetch_optional(attached_skill_statement(), (skill_id, name))
            .await;
    }
    if reference.is_public {
        return mysql
            .fetch_optional(public_skill_statement(), (name,))
            .await;
    }
    if let Some(skill) = mysql
        .fetch_optional(
            personal_skill_statement(),
            (user, name.clone(), reference.namespace.to_string()),
        )
        .await?
    {
        return Ok(Some(skill));
    }
    if reference.namespace != "default"
        && let Some(skill) = mysql
            .fetch_optional(
                group_skill_statement(),
                (name.clone(), reference.namespace.to_string()),
            )
            .await?
    {
        return Ok(Some(skill));
    }
    if team_namespace != "default"
        && team_namespace != reference.namespace
        && let Some(skill) = mysql
            .fetch_optional(
                group_skill_statement(),
                (name.clone(), team_namespace.to_string()),
            )
            .await?
    {
        return Ok(Some(skill));
    }
    if reference.namespace != "default" {
        return mysql
            .fetch_optional(
                personal_skill_statement(),
                (user, name, "default".to_string()),
            )
            .await;
    }
    Ok(None)
}

/// The shells `_prepare_mcp_for_coding_executor` prepares (`request_builder.py:470`).
pub fn is_coding_shell(shell_type: &str) -> bool {
    matches!(shell_type, "ClaudeCode" | "Codex")
}

pub fn append_coding_mcp(servers: &mut Vec<Value>, skills: &BotSkills, shell: &str) {
    let mut names = HashMap::new();
    for skill in &skills.skills {
        let Some(entries) = skill["mcpServers"].as_object() else {
            continue;
        };
        let name = skill["name"].as_str().unwrap_or("unknown");
        for (server, config) in entries {
            let Some(mut config) = config.as_object().filter(|_| !server.is_empty()).cloned()
            else {
                continue;
            };
            let identity = (name.to_owned(), server.clone());
            let mut attempt = 0;
            let mut resolved = mcp_name(name, server, attempt);
            while names.get(&resolved).is_some_and(|owner| owner != &identity) {
                attempt += 1;
                resolved = mcp_name(name, server, attempt);
            }
            names.insert(resolved.clone(), identity);
            config.insert("name".into(), Value::String(resolved));
            servers.push(Value::Object(config));
        }
    }
    if shell == "ClaudeCode" {
        for server in servers.iter_mut() {
            if server["type"] == "streamable-http" {
                server["type"] = Value::String("http".into())
            }
        }
        servers.retain(|server| {
            server["type"] == "stdio" || server["url"].as_str().is_some_and(|s| !s.is_empty())
        });
    }
}

fn mcp_name(skill: &str, server: &str, attempt: u64) -> String {
    fn code(name: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(name.as_bytes()))
            .chars()
            .take(7)
            .map(|c| {
                if c.is_ascii_digit() {
                    char::from(b'g' + c as u8 - b'0')
                } else {
                    c
                }
            })
            .collect()
    }
    fn sanitize(name: &str, fallback: &str) -> String {
        let mut result: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        if result.is_empty() {
            result = fallback.into()
        }
        if !result.starts_with(|c: char| c.is_alphabetic()) {
            result.insert_str(0, "s-")
        }
        result
    }
    let mut compact = sanitize(server, "server");
    if compact.len() > 24 {
        compact = format!("{}_{}", &compact[..16], code(server))
    }
    if skill == server && attempt == 0 {
        return compact;
    }
    let readable = format!("{}_{}", sanitize(skill, "skill"), compact);
    if attempt == 0 && readable.len() <= 32 {
        return readable;
    }
    let identity = if attempt == 0 {
        skill.to_owned()
    } else {
        format!("{skill}\0{server}\0{attempt}")
    };
    format!("{}_{}", code(&identity), compact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coding_mcp_names_and_claude_filter_match_runtime_contract() {
        assert_eq!(mcp_name("github", "github", 0), "github");
        assert_eq!(mcp_name("skill", "server", 0), "skill_server");
        assert!(mcp_name("long-skill-name-that-needs-compaction", "server", 0).len() <= 32);
        assert_ne!(
            mcp_name("skill", "server", 0),
            mcp_name("skill", "server", 1)
        );
        let skills = BotSkills {
            skills: vec![
                serde_json::json!({"name":"github","mcpServers":{"github":{"type":"streamable-http","url":"https://mcp.invalid"},"invalid":{"type":"http"}}}),
            ],
            ..Default::default()
        };
        let mut servers = Vec::new();
        append_coding_mcp(&mut servers, &skills, "ClaudeCode");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "github");
        assert_eq!(servers[0]["type"], "http");
    }
}

/// The late resolution's own Bot and Ghost lifecycle (`unified.py:382-391`).
///
/// `prepare_execution_request` builds the initial request on its own
/// `TaskRequestBuilder`; `unified.py:266` then creates a new builder for
/// post-processing, whose `_cached_ghost_chains` starts empty. The first late
/// `resolve_request_preload_skills` therefore re-reads the subtask Bot
/// (`_get_bot_for_subtask`) and re-resolves its Ghost through the cached kind
/// reader before `_get_bot_skills` compiles the Skills.
pub struct LateBotReads<'a, M: Mysql, R: brz_redis::Redis> {
    /// The `kindReader` over the post-processing builder's clients.
    pub cache: &'a crate::task_skills::kinds::KindCacheStore<'a, M, R>,
    /// `assistant_subtask.bot_ids[0]`.
    pub bot_id: Option<i64>,
    /// `team.user_id`: the Ghost chain owner and the cached Bot reader scope.
    pub owner_user_id: i64,
    /// `team_crd.spec.members[0].botRef` for `_get_first_bot`.
    pub first_member: Option<(&'a str, &'a str)>,
}

/// The late resolution's reader inputs (`unified.py:266,382-391`):
/// `bot_ids` is `assistant_subtask.bot_ids`, `team_json` supplies
/// `team_crd.spec.members[0].botRef` for `_get_first_bot`, and `team_user_id`
/// is `team.user_id`, the Ghost chain owner and cached Bot reader scope.
pub fn late_bot_reads<'a, M: Mysql, R: brz_redis::Redis>(
    cache: &'a crate::task_skills::kinds::KindCacheStore<'a, M, R>,
    bot_ids: &[i64],
    team_json: &'a Value,
    team_user_id: i64,
) -> LateBotReads<'a, M, R> {
    LateBotReads {
        cache,
        bot_id: bot_ids.first().copied(),
        owner_user_id: team_user_id,
        first_member: first_member_ref(team_json),
    }
}

/// `team_crd.spec.members[0].botRef` (`BotTeamRef`: `namespace` defaults to
/// `"default"`).
fn first_member_ref(team_json: &Value) -> Option<(&str, &str)> {
    let bot = team_json
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(Value::as_array)
        .and_then(|members| members.first())
        .and_then(|member| member.get("botRef"))?;
    Some((
        bot.get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default"),
        bot.get("name").and_then(Value::as_str)?,
    ))
}

/// `_get_bot_for_subtask` (`request_builder.py:1110-1145`): the subtask's
/// first bot id read with the Bot + active predicates, else `_get_first_bot`'s
/// cached read of the team's first member. `None` skips the late resolution,
/// matching `unified.py:385`'s `if bot:` guard.
async fn late_subtask_bot<M: Mysql, R: brz_redis::Redis>(
    reads: &LateBotReads<'_, M, R>,
) -> Result<Option<crate::resolution::KindRow>, FastApiError> {
    if let Some(bot) = super::super::subtask_bot::bot_by_id(reads.cache.mysql, reads.bot_id)
        .await
        .map_err(super::dependency)?
    {
        return Ok(Some(bot));
    }
    let Some((namespace, name)) = reads.first_member else {
        return Ok(None);
    };
    reads
        .cache
        .get_by_name_and_namespace_row(reads.owner_user_id, "Bot", namespace, name)
        .await
        .map_err(super::dependency)
        .map(|row| row.map(crate::resolution::kinds_row))
}

/// The late `_get_bot_skills` Ghost chain (`request_builder.py:1653` ->
/// `_get_bot_ghost_chain` -> `load_ghost_chain`): because the post-processing
/// builder's chain cache is empty, the cached reader re-reads the Ghost once
/// and the merged capabilities are rebuilt from that live chain. A Bot with no
/// `ghostRef` yields no capabilities, as `_get_bot_skills` returns empty
/// containers in that branch.
async fn late_ghost_capabilities<M: Mysql, R: brz_redis::Redis>(
    reads: &LateBotReads<'_, M, R>,
    bot: &crate::resolution::KindRow,
) -> Result<MergedGhostCapabilities, FastApiError> {
    let Some(reference) = bot
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("ghostRef"))
        .filter(|reference| !reference.is_null())
    else {
        return Ok(MergedGhostCapabilities::default());
    };
    let namespace = reference
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let name = reference.get("name").and_then(Value::as_str).unwrap_or("");
    let chain =
        super::super::ghost::load_ghost_chain(reads.cache, reads.owner_user_id, namespace, name)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to load the late bot ghost chain");
                FastApiError::internal()
            })?;
    Ok(super::super::ghost::merge_ghost_capabilities(&chain))
}

/// `_get_bot_skills`' `bot_crd.spec.capability_mode` for the late Bot.
fn late_capability_mode(bot: &crate::resolution::KindRow) -> &str {
    bot.json
        .0
        .get("spec")
        .and_then(|spec| spec.get("capability_mode"))
        .and_then(Value::as_str)
        .unwrap_or("manual")
}

/// `TaskRequestBuilder.resolve_request_preload_skills`
/// (`request_builder.py:828-975`), reached from `unified.py:367-385` when
/// context processing adds a provider Skill after the initial build. The
/// provider Skill is resolved through the ordinary Skill loader, so its
/// `skill_refs` entry (id/namespace/is_public/content_hash) comes from the live
/// Skill row rather than the stored ref.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_request_preload_skills<
    M: Mysql,
    R: brz_redis::Redis,
    T: UserMcpAccessTokens,
>(
    mysql: &M,
    request: &mut wegent_protocol::dispatch::ExecutionRequest,
    reads: &LateBotReads<'_, M, R>,
    user_id: i64,
    user_preferences: Option<&str>,
    tokens: &T,
    access: &SkillAccess<'_>,
    team_namespace: &str,
) -> Result<(), FastApiError> {
    let requested = requested_skill_names(request);
    if requested.is_empty() {
        return Ok(());
    }
    let existing: std::collections::HashSet<String> = request
        .skill_names
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let missing: Vec<String> = requested
        .iter()
        .filter(|name| !existing.contains(*name))
        .cloned()
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    // `unified.py:382-391`: the late resolution selects the Bot on the
    // post-processing builder, then `_get_bot_skills` re-resolves its Ghost
    // chain against that builder's empty chain cache.
    let Some(bot) = late_subtask_bot(reads).await? else {
        return Ok(());
    };
    let merged = late_ghost_capabilities(reads, &bot).await?;
    let bot_capability_mode = late_capability_mode(&bot);

    let references = user_preload_skill_refs(request, &requested);
    let mut skills = super::get_bot_skills(
        mysql,
        &merged,
        bot_capability_mode,
        user_id,
        user_preferences,
        tokens,
        &format!("user:{user_id}"),
        Some(access),
        reads.owner_user_id,
        team_namespace,
        &references,
        // `_get_bot_skills` is called without `user_available_skills` here, so
        // its available stage has nothing to resolve.
        &[],
    )
    .await?;

    // `request_builder.py:900-916`: a coding coordinate build also resolves the
    // skills that only the member bot configs carry, before the request fields
    // are replaced.
    if coding_coordinate(request) {
        extend_resolved_skills_from_bot_configs(
            reads.cache,
            request
                .bot
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default(),
            &mut skills,
            user_preferences,
            tokens,
            reads.owner_user_id,
            team_namespace,
        )
        .await?;
    }

    request.skill_configs = skills.skills.clone();
    request.skill_names = skills
        .skills
        .iter()
        .filter_map(|skill| skill.get("name").cloned())
        .collect();
    request.preload_skills = skills
        .preload_skills
        .iter()
        .map(|name| Value::String(name.clone()))
        .collect();
    request.user_selected_skills = skills
        .user_selected_skills
        .iter()
        .map(|name| Value::String(name.clone()))
        .collect();
    request.skill_refs = Value::Object(skills.skill_refs.clone());
    request.preload_skill_refs = super::preload_skill_refs(&skills);

    // `request_builder.py:936-942`: the leader bot gains the newly resolved
    // skill names.
    let Some(bots) = request.bot.as_array_mut() else {
        return Ok(());
    };
    let Some(leader) = bots.first_mut() else {
        return Ok(());
    };
    let mut names: Vec<Value> = leader
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for name in &missing {
        if !names
            .iter()
            .any(|existing| existing.as_str() == Some(name.as_str()))
        {
            names.push(Value::String(name.clone()));
        }
    }
    leader["skills"] = Value::Array(names);

    // `request_builder.py:940` -> `_sync_skill_refs_to_bot_configs`
    // (`:2312-2333`): every bot config syncs its own string skill names from
    // the resolved map.
    for bot in bots.iter_mut() {
        sync_bot_skill_refs(bot, &skills.skill_refs);
    }

    // The execution builder compiles the complete final Skill set after
    // connector availability has replaced any superseded personal servers.
    Ok(())
}

/// `_sync_skill_refs_to_bot_configs` for one bot config (`:2312-2333`): a bot
/// whose filtered string skill names are empty is skipped entirely, preserving
/// its `skill_refs` field presence; otherwise each of its skills receives the
/// resolved ref unless a stored identity disagrees on `skill_id`/`namespace`.
pub fn sync_bot_skill_refs(bot: &mut Value, resolved: &serde_json::Map<String, Value>) {
    let bot_skills: Vec<String> = bot
        .get("skills")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if bot_skills.is_empty() {
        return;
    }
    // `bot_config.setdefault("skill_refs", {})`.
    let mut bot_refs = bot
        .get("skill_refs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for name in bot_skills {
        let Some(reference) = resolved.get(&name) else {
            continue;
        };
        let replace = match bot_refs.get(&name) {
            None => true,
            Some(current) => {
                current.get("skill_id").is_none_or(Value::is_null)
                    || skill_refs_match(current, reference)
            }
        };
        if replace {
            bot_refs.insert(name, reference.clone());
        }
    }
    bot["skill_refs"] = Value::Object(bot_refs);
}

/// `_skill_refs_match` (`request_builder.py:2336-2339`): a stored ref is
/// replaced only when it agrees on `skill_id` and `namespace`. Python's
/// `dict.get("namespace", "default")` defaults only when the member is absent,
/// so an explicit `null` or non-string namespace compares as its real value.
fn skill_refs_match(current: &Value, resolved: &Value) -> bool {
    current.get("skill_id") == resolved.get("skill_id")
        && namespace_value(current) == namespace_value(resolved)
}

/// The member's `namespace`, or the literal `"default"` only when the key is
/// absent (a present `null`/non-string stays a real value).
fn namespace_value(reference: &Value) -> Option<Value> {
    match reference {
        Value::Object(map) => Some(
            map.get("namespace")
                .cloned()
                .unwrap_or_else(|| Value::String("default".to_string())),
        ),
        _ => Some(Value::String("default".to_string())),
    }
}

/// `request.bot[0]` is a coding shell and the team uses coordinate mode
/// (`request_builder.py:904-908`).
fn coding_coordinate(request: &wegent_protocol::dispatch::ExecutionRequest) -> bool {
    request.collaboration_model == "coordinate"
        && request
            .bot
            .as_array()
            .and_then(|bots| bots.first())
            .and_then(|bot| bot.get("shell_type"))
            .and_then(Value::as_str)
            .is_some_and(is_coding_shell)
}

/// `_extend_resolved_skills_from_bot_configs` (`request_builder.py:2746-2787`):
/// resolve every skill a member bot config declares but the resolution has not
/// produced yet. An unpinned Skill follows the Team's runtime lookup scope.
pub async fn extend_resolved_skills_from_bot_configs<
    M: Mysql,
    R: brz_redis::Redis,
    T: UserMcpAccessTokens,
>(
    cache: &crate::task_skills::kinds::KindCacheStore<'_, M, R>,
    bot_configs: &[Value],
    skills: &mut BotSkills,
    user_preferences: Option<&str>,
    tokens: &T,
    team_owner_id: i64,
    team_namespace: &str,
) -> Result<(), FastApiError> {
    let mut existing: Vec<String> = skills
        .skills
        .iter()
        .filter_map(|skill| {
            skill
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    for bot in bot_configs {
        let Some(names) = bot.get("skills").and_then(Value::as_array) else {
            continue;
        };
        for name in names.iter().filter_map(Value::as_str) {
            if existing.iter().any(|seen| seen == name) {
                continue;
            }
            let skill_id = bot
                .get("skill_refs")
                .and_then(|refs| refs.get(name))
                .and_then(|reference| reference.get("skill_id"))
                .and_then(Value::as_i64);
            let skill = if let Some(id) = skill_id {
                super::resolve_binding_ref_skill(cache.mysql, Some(id), name).await
            } else {
                crate::task_skills::resolver::find_skill_by_name(
                    cache,
                    name,
                    team_owner_id,
                    team_namespace,
                )
                .await
                .map(|row| row.map(SkillKindRow::from))
            }
            .map_err(super::dependency)?;
            let Some(skill) = skill else {
                continue;
            };
            skills
                .skills
                .push(super::build_skill_data_with_oauth(&skill, user_preferences, tokens).await?);
            existing.push(name.to_string());
            skills.skill_refs.insert(
                name.to_string(),
                serde_json::to_value(super::SkillRefMeta::from_kind(&skill)).unwrap_or(Value::Null),
            );
        }
    }
    Ok(())
}

/// `request.preload_skills` + `request.user_selected_skills`, deduplicated in
/// order (`request_builder.py:842-848`).
fn requested_skill_names(request: &wegent_protocol::dispatch::ExecutionRequest) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for value in request
        .preload_skills
        .iter()
        .chain(request.user_selected_skills.iter())
    {
        if let Some(name) = value.as_str()
            && !names.iter().any(|existing| existing == name)
        {
            names.push(name.to_string());
        }
    }
    names
}

/// The explicit refs `resolve_request_preload_skills` builds for the requested
/// names (`request_builder.py:870-889`): the stored ref's namespace/is_public
/// and skill id, overridden to the public default for an MCP provider Skill and
/// for `wegent-knowledge` while the request carries knowledge bases.
fn user_preload_skill_refs(
    request: &wegent_protocol::dispatch::ExecutionRequest,
    requested: &[String],
) -> Vec<Value> {
    let has_knowledge_bases = request
        .knowledge_base_ids
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty());
    requested
        .iter()
        .map(|name| {
            let stored = request.skill_refs.get(name);
            let mut reference = serde_json::json!({
                "name": name,
                "namespace": stored
                    .and_then(|reference| reference.get("namespace"))
                    .and_then(Value::as_str)
                    .unwrap_or("default"),
                "is_public": stored
                    .and_then(|reference| reference.get("is_public"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
            if let Some(skill_id) = stored
                .and_then(|reference| reference.get("skill_id"))
                .filter(|value| !value.is_null())
            {
                reference["skill_id"] = skill_id.clone();
            }
            // `SELECTED_KB_PRELOAD_SKILL` is the Source's knowledge provider
            // Skill name; its row, id and hash come from the Skill loader.
            if crate::mcp_provider_registry::get_mcp_service_by_skill_name(name).is_some()
                || (name == "wegent-knowledge" && has_knowledge_bases)
            {
                reference["namespace"] = Value::String("default".to_string());
                reference["is_public"] = Value::Bool(true);
            }
            reference
        })
        .collect()
}

#[cfg(test)]
#[path = "skills_requested_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "skills_requested_ref_tests.rs"]
mod ref_tests;

#[cfg(test)]
#[path = "skills_requested_late_tests.rs"]
mod late_resolution_tests;
