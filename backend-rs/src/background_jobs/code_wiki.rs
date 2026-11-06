//! Code Wiki scheduled admission. Wiki content APIs keep their existing owner.
#[path = "code_wiki_generation.rs"]
pub(crate) mod generation;
#[path = "code_wiki_prompt.rs"]
mod prompt;
#[path = "code_wiki_repository.rs"]
mod repository;
#[path = "code_wiki_task.rs"]
mod task;
use super::{
    model::{self, Execute, SUBSCRIPTION_COLUMNS, Subscription},
    state,
};
use crate::{AppState, responses::create::resolution};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Debug, Clone, FromMysqlRow)]
pub(super) struct Wiki {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub namespace: String,
    pub json: Json<Value>,
    pub is_active: i64,
}
#[derive(FromMysqlRow)]
struct User {
    user_name: String,
    role: String,
    is_active: i64,
    preferences: String,
}

/// The code-wiki runner's `User` row (`db.query(User)` in the source), which
/// supplies both the display name and the `preferences` document the request
/// builder reads.
async fn load_runner_user<M: Mysql>(mysql: &M, runner: i64) -> Result<Option<User>> {
    Ok(mysql
        .fetch_optional(
            "SELECT user_name,role,is_active,preferences FROM users WHERE id=?",
            (runner,),
        )
        .await?)
}
pub(super) struct Strategy {
    pub id: String,
    pub team: resolution::KindRow,
    pub reviewer: String,
    pub writer: String,
    pub review: bool,
}

pub(crate) async fn execute(
    app: Arc<AppState>,
    ctx: brz_schedule::JobContext,
    input: Execute,
) -> Result<Value> {
    let key = format!("wegent:lock:code_wiki_execution:{}", input.execution_id);
    super::super::with_lock_watchdog(
        &app.background_jobs,
        &ctx,
        &key,
        Duration::from_secs(120),
        async {
            let outcome = launch(&app, &input).await;
            if let Err(error) = &outcome {
                state::transition(
                    &app.mysql,
                    app.redis.as_ref(),
                    input.execution_id,
                    "FAILED",
                    None,
                    Some(&error.to_string()),
                )
                .await?;
            }
            outcome
        },
    )
    .await
    .map(|v| v.unwrap_or_else(|| json!({"status":"skipped","reason":"execution_locked"})))
}
async fn silent(app: &AppState, input: &Execute, reason: &str) -> Result<Value> {
    state::transition(
        &app.mysql,
        app.redis.as_ref(),
        input.execution_id,
        "COMPLETED_SILENT",
        Some(reason),
        None,
    )
    .await?;
    Ok(json!({"status":"skipped","reason":reason}))
}
async fn launch(app: &AppState, input: &Execute) -> Result<Value> {
    let Some(snapshot) = model::subscription(&app.mysql, input.subscription_id, false).await?
    else {
        return Ok(json!({"status":"skipped"}));
    };
    let Some(wiki_id) = model::code_wiki_id(&snapshot) else {
        return Ok(json!({"status":"skipped"}));
    };
    let Some(execution) = model::execution(&app.mysql, input.execution_id).await? else {
        return Ok(json!({"status":"skipped"}));
    };
    if execution.subscription_id != snapshot.id || execution.user_id != snapshot.user_id {
        bail!("Scheduled Code Wiki execution identity does not match")
    }
    if model::terminal(&execution.status) {
        return Ok(json!({"status":"skipped","reason":"execution_terminal"}));
    }
    let linked:Option<brz_mysql::MysqlRow>=app.mysql.fetch_optional("SELECT id,task_id FROM wiki_generations WHERE kind_id=? AND JSON_EXTRACT(ext,'$.backgroundExecutionId')=? ORDER BY id DESC LIMIT 1",(wiki_id,input.execution_id)).await?;
    if let Some(linked) = linked {
        let generation = linked.get_at::<i64>(0)?;
        let task = linked.get_at::<i64>(1)?;
        if task > 0 {
            app.mysql.with_transaction(async|tx|{tx.execute("UPDATE background_executions SET task_id=?,status='RUNNING',updated_at=UTC_TIMESTAMP() WHERE id=? AND subscription_id=? AND task_id IN (0,?) AND status IN ('PENDING','RUNNING','RETRYING')",(task,execution.id,snapshot.id,task)).await?;Ok(())}).await?;
            return Ok(
                json!({"status":"started","generation_id":generation,"task_id":task,"redelivery":true}),
            );
        }
        generation::fail(
            &app.mysql,
            generation,
            "task_not_created",
            "Launcher stopped before creating its generation Task",
        )
        .await?;
        bail!("Launcher stopped before creating its generation Task");
    }
    if !state::transition(
        &app.mysql,
        app.redis.as_ref(),
        input.execution_id,
        "RUNNING",
        None,
        None,
    )
    .await?
    {
        return Ok(json!({"status":"skipped","reason":"execution_terminal"}));
    }
    // Configuration/deletion and admission use the same KB -> plan lock order.
    let pair=app.mysql.with_transaction(async|tx|{let wiki:Option<Wiki>=tx.fetch_optional("SELECT id,user_id,name,namespace,json,is_active FROM kinds WHERE id=? FOR UPDATE",(wiki_id,)).await?;let plan:Option<Subscription>=tx.fetch_optional(format!("SELECT {SUBSCRIPTION_COLUMNS} FROM kinds WHERE id=? AND kind='Subscription' FOR UPDATE"),(snapshot.id,)).await?;Ok((wiki,plan))}).await?;
    let (Some(wiki), Some(plan)) = pair else {
        bail!("Code Wiki no longer exists or its reference no longer matches")
    };
    if plan.is_active == 0 {
        return silent(app, input, "Skipped because scheduled update was deleted").await;
    }
    if plan.json.0["_internal"]["enabled"] != true {
        return silent(app, input, "Skipped because scheduled update was disabled").await;
    }
    if !references(&plan, &wiki) || wiki.is_active == 0 {
        bail!("Code Wiki no longer exists or its reference no longer matches")
    }
    if generation::in_flight(app, wiki.id).await? {
        return silent(app, input, "Skipped because another generation is running").await;
    }
    let runner = wiki.json.0["spec"]["executionPrincipalUserId"]
        .as_i64()
        .filter(|v| *v > 0)
        .unwrap_or(wiki.user_id);
    let user = load_runner_user(&app.mysql, runner)
        .await?
        .filter(|u| u.is_active != 0)
        .context("RUNNER_INACTIVE: configured generation runner is inactive")?;
    require_namespace(app, &wiki, runner, &user.role).await?;
    let repo = repository::resolve(app, runner, &wiki.json.0["spec"]["source"]).await?;
    let policy = policy(app).await?;
    let legacy = strategy(app, runner, &policy, "legacy").await?;
    let selected_id = wiki.json.0["spec"]["generationStrategy"]
        .as_str()
        .unwrap_or("legacy");
    let selected = if selected_id == "legacy" {
        None
    } else {
        Some(strategy(app, runner, &policy, selected_id).await?)
    };
    let previous = generation::published(app, &wiki).await?;
    let revision = repo
        .revision(
            &previous.commit,
            previous.count.is_none() && !previous.commit.is_empty(),
        )
        .await;
    let (mode, reason) = generation::mode(app, &wiki, &previous, &revision).await?;
    if mode == "skip" {
        return silent(app, input, &reason).await;
    }
    let strategy = if mode == "full" {
        selected.as_ref().unwrap_or(&legacy)
    } else {
        &legacy
    };
    let Some(id) = generation::start(
        app,
        &wiki,
        &plan,
        input.execution_id,
        runner,
        strategy,
        &mode,
        &reason,
        &revision,
        &previous,
    )
    .await?
    else {
        return silent(app, input, "Skipped because another generation is running").await;
    };
    let pages = generation::pages(app, id).await?;
    let language = if wiki.json.0["spec"]["language"]
        .as_str()
        .map(str::to_lowercase)
        .unwrap_or_else(|| {
            crate::config::env_or_dotenv("WIKI_DEFAULT_LANGUAGE").unwrap_or_else(|| "en".into())
        })
        == "zh"
    {
        "Chinese (Simplified)"
    } else {
        "English"
    };
    let prompt = prompt::build(
        &prompt::Context {
            project: &repo.project,
            generation: id,
            head: &revision.head,
            previous: &previous.commit,
            language,
            strategy: &strategy.id,
            reviewer: &strategy.reviewer,
            writer: &strategy.writer,
            changed: revision.changed.as_deref().unwrap_or(&[]),
            existing: &pages,
        },
        mode == "full",
    );
    match task::create(
        app,
        &wiki,
        runner,
        &user.user_name,
        &user.preferences,
        &strategy.team,
        id,
        input.execution_id,
        &prompt,
    )
    .await
    {
        Ok(task_id) => {
            app.mysql.with_transaction(async|tx|{tx.execute("UPDATE background_executions SET task_id=?,result_summary=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND subscription_id=? AND status='RUNNING'",(task_id,format!("{mode} generation started"),input.execution_id,plan.id)).await?;Ok(())}).await?;
            Ok(json!({"status":"started","generation_id":id,"task_id":task_id,"mode":mode}))
        }
        Err(error) => {
            generation::fail(&app.mysql, id, "task_not_created", &error.to_string()).await?;
            Err(error)
        }
    }
}
fn references(plan: &Subscription, wiki: &Wiki) -> bool {
    let r = &plan.json.0["spec"]["codeWikiRef"];
    r["id"].as_i64() == Some(wiki.id)
        && r["name"].as_str() == Some(&wiki.name)
        && r["namespace"].as_str() == Some(&wiki.namespace)
        && r["userId"].as_i64() == Some(wiki.user_id)
        && wiki.json.0["spec"]["kbType"] == "code_wiki"
}
async fn require_namespace(app: &AppState, wiki: &Wiki, user: i64, role: &str) -> Result<()> {
    if wiki.namespace == "default" {
        return Ok(());
    }
    let access = &crate::knowledge_documents_content::access::is_organization_namespace(
        &app.mysql,
        &wiki.namespace,
    )
    .await?;
    if role == "admin" && *access {
        return Ok(());
    }
    let role = crate::knowledge_documents_content::group_membership::effective_role_in_group(
        &app.mysql,
        app.redis.as_ref(),
        &app.entity_resolvers,
        user,
        &wiki.namespace,
    )
    .await?;
    if !role
        .as_deref()
        .is_some_and(|r| crate::knowledge_documents_content::access::has_permission(r, "Developer"))
    {
        bail!(
            "NAMESPACE_ACCESS_DENIED: generation runner requires a Developer role in the knowledge-base namespace"
        )
    }
    Ok(())
}
async fn policy(app: &AppState) -> Result<Value> {
    let row:Option<brz_mysql::MysqlRow>=app.mysql.fetch_optional("SELECT config_value FROM system_configs WHERE config_key='code_wiki_generation_policy' LIMIT 1",()).await?;
    if let Some(row) = row {
        return Ok(serde_json::from_str(&row.get_at::<String>(0)?)?);
    }
    if let Some(raw) = crate::config::env_or_dotenv("WIKI_CODE_WIKI_GENERATION_POLICY") {
        return Ok(serde_json::from_str(&raw)?);
    }
    let name = crate::config::env_or_dotenv("WIKI_CODE_WIKI_TEAM_NAME")
        .unwrap_or_else(|| "code-wiki-team".into());
    Ok(
        json!({"strategies":{"legacy":{"enabled":true,"teamRef":{"name":name,"namespace":"default"}},"coordinator_adaptive":{"enabled":true,"teamRef":{"name":name,"namespace":"default"}},"coordinator_reviewed":{"enabled":true,"teamRef":{"name":name,"namespace":"default"}}}}),
    )
}
async fn strategy(app: &AppState, user: i64, policy: &Value, id: &str) -> Result<Strategy> {
    if !matches!(
        id,
        "legacy" | "coordinator_adaptive" | "coordinator_reviewed" | "coordinator_solo"
    ) {
        bail!("Unknown Code Wiki generation strategy '{id}'")
    }
    let binding = &policy["strategies"][id];
    if !binding.is_object() || binding["enabled"] == false {
        bail!("Code Wiki generation strategy '{id}' is not enabled")
    }
    let reference = binding
        .get("teamRef")
        .or(binding.get("team_ref"))
        .context("Code Wiki strategy Team is missing")?;
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &app.mysql,
        redis: app.redis.as_ref(),
        erp: Some(app.erp.as_ref()),
        resolvers: Some(&app.entity_resolvers),
    };
    let team = resolution::resolve_team(
        &cache,
        user,
        reference["namespace"].as_str().unwrap_or("default"),
        reference["name"].as_str().unwrap_or(""),
    )
    .await?
    .context("Code Wiki strategy Team is unavailable")?;
    let review = id == "coordinator_reviewed"
        || (id == "legacy" && team.json.0["spec"]["collaborationModel"] == "coordinate");
    let reviewer = if review {
        member(app, &team, "reviewer", true).await?
    } else {
        String::new()
    };
    let writer = if id == "coordinator_adaptive" || review {
        member(app, &team, "writer", id == "coordinator_adaptive").await?
    } else {
        String::new()
    };
    Ok(Strategy {
        id: id.into(),
        team,
        reviewer,
        writer,
        review,
    })
}
async fn member(
    app: &AppState,
    team: &resolution::KindRow,
    role: &str,
    required: bool,
) -> Result<String> {
    let member = team.json.0["spec"]["members"]
        .as_array()
        .and_then(|members| members.iter().find(|m| m["role"] == role));
    let Some(member) = member else {
        if required {
            bail!("Code Wiki strategy Team has no {role} Bot")
        }
        return Ok(String::new());
    };
    let reference = &member["botRef"];
    let bot = resolution::resolve_bot(
        &app.mysql,
        team.user_id,
        reference["namespace"].as_str().unwrap_or("default"),
        reference["name"].as_str().unwrap_or(""),
    )
    .await?
    .context("Code Wiki strategy Bot was not found")?;
    let name = bot
        .name
        .trim()
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                Some(c.to_ascii_lowercase())
            } else if c == '_' || c.is_whitespace() {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>();
    let normalized = name.trim_matches('-');
    Ok(format!(
        "{}-{}",
        if normalized.is_empty() {
            "unnamed"
        } else {
            normalized
        },
        bot.id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The code-wiki builder runs as the resolved `task_user` and the source
    /// passes that whole row to the request builder, so its `preferences`
    /// document reaches `_build_skill_data`'s user-managed provider branch.
    #[tokio::test]
    async fn runner_read_carries_the_preferences_document() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let user = load_runner_user(&mysql, 42).await.expect("read");
        assert!(user.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            "SELECT user_name,role,is_active,preferences FROM users WHERE id=?"
        );
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].first_integer, Some(42));
    }
}
