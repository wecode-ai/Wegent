//! Issue invitations use the same collaborator rows with or without a project.

use std::collections::HashSet;

use brz_http_server::{Response, StatusCode};
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::json;
use wegent_project_coordination::loop_tasks::issue_invitation::TEAM_INVITATION_SOURCE;
use wegent_project_coordination::project_store::DATABASE_NOW_SQL;

use super::{
    AppState, FastApiError, Issue, Metadata, SessionUser, assignment_count, assistant, internal,
    locked, locked_issue_node,
};

#[derive(FromMysqlRow)]
struct IssueScope {
    project_id: Option<String>,
    security_level: Option<String>,
}

#[brz_http_server::delete("/api/v1/loop-items/:item_id/collaborators/:collaborator_user_id")]
pub(super) async fn remove_collaborator(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    item_id: &str,
    collaborator_user_id: i32,
) -> Result<Response, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |tx| remove_on(tx, item_id, collaborator_user_id, user.0.id).await)
        .await
        .map_err(internal)?;
    if let Some(assignee) = outcome? {
        assignment_count::invalidate(state, assignee).await;
    }
    Ok(Response::empty(StatusCode::NO_CONTENT))
}

async fn remove_on(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    recipient: i32,
    actor: i32,
) -> MysqlResult<Result<Option<i32>, FastApiError>> {
    let personal = match authorize_removal(tx, issue_id, actor).await? {
        Ok(personal) => personal,
        Err(error) => return Ok(Err(error)),
    };
    let invitation: Option<(String,)> = tx.fetch_optional(
        "SELECT id FROM loop_items WHERE resource_type='collaborator' AND loop_item_id=? AND user_id=?
         AND COALESCE(source,'')<>? ORDER BY id LIMIT 1 FOR UPDATE",
        (issue_id, recipient, TEAM_INVITATION_SOURCE),
    ).await?;
    let Some((id,)) = invitation else {
        return Ok(Err(missing("Collaborator not found")));
    };
    let keep_team_invitation = personal.as_ref().is_some_and(|issue| {
        issue
            .metadata
            .0
            .resource_participants
            .iter()
            .any(|resource| resource.human_ids.contains(&recipient))
    });
    if keep_team_invitation {
        tx.execute(
            "UPDATE loop_items SET source=? WHERE id=?",
            (TEAM_INVITATION_SOURCE, id),
        )
        .await?;
    } else {
        tx.execute("DELETE FROM loop_items WHERE id=?", (id,))
            .await?;
    }
    match personal {
        Some(issue) => Ok(Ok(
            update_personal_issue(tx, &issue, recipient, actor).await?
        )),
        None => Ok(Ok(None)),
    }
}

async fn authorize_removal(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    actor: i32,
) -> MysqlResult<Result<Option<Issue>, FastApiError>> {
    let scope: Option<IssueScope> = tx.fetch_optional(
        "SELECT NULLIF(cloud_project_id,'') AS project_id,
         CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.security_level')),'null')
            AS CHAR CHARACTER SET utf8mb4) AS security_level
         FROM loop_items WHERE id=? AND resource_type='task'
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",
        (issue_id,),
    ).await?;
    let Some(scope) = scope else {
        return Ok(Err(missing("TODO not found")));
    };
    if let Some(project_id) = scope.project_id {
        if let Err(error) =
            wegent_project_coordination::loop_tasks::item_access::require_project_collaborator_edit(
                &mut &mut *tx,
                issue_id,
                &project_id,
                scope.security_level.as_deref(),
                actor,
            )
            .await
        {
            return Ok(Err(error.into_fastapi()));
        }
        Ok(Ok(None))
    } else {
        let Some(issue) = locked(tx, issue_id)
            .await?
            .filter(|row| row.can_read(actor))
        else {
            return Ok(Err(missing("TODO not found")));
        };
        if issue.creator_id != actor {
            return Ok(Err(FastApiError::forbidden(
                "Only the creator can manage invitations",
            )));
        }
        Ok(Ok(Some(issue)))
    }
}

async fn update_personal_issue(
    tx: &mut impl MysqlTransaction,
    issue: &Issue,
    recipient: i32,
    actor: i32,
) -> MysqlResult<Option<i32>> {
    let issue_id = issue.id.as_str();
    let cleared = issue.assignee_id.filter(|assignee| *assignee == recipient);
    if cleared.is_some() {
        let assignment_issue = locked_issue_node(tx, issue_id).await?;
        assistant::retire_reservation(tx, issue_id, issue.metadata.0.assignment_id.as_deref())
            .await?;
        crate::background_jobs::project::assignments::clear_human_assignment(
            tx,
            &assignment_issue,
            i64::from(actor),
        )
        .await?;
        tx.execute(
            format!(
                "UPDATE loop_items SET assignee_user_id=NULL,
             metadata=JSON_REMOVE(metadata,'$.assignment_id','$.assigned_at'),
             version=version+1,updated_at={DATABASE_NOW_SQL} WHERE id=?"
            ),
            (issue_id,),
        )
        .await?;
    } else {
        tx.execute(
            format!(
                "UPDATE loop_items SET version=version+1,updated_at={DATABASE_NOW_SQL} WHERE id=?"
            ),
            (issue_id,),
        )
        .await?;
    }
    Ok(cleared)
}

fn missing(detail: &str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

fn source(direct: &HashSet<i32>, user_id: i32) -> &'static str {
    if direct.contains(&user_id) {
        "manual"
    } else {
        TEAM_INVITATION_SOURCE
    }
}

async fn insert(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    user_id: i32,
    actor_id: i32,
    source: &str,
) -> MysqlResult<()> {
    wegent_project_coordination::project_store::insert(
        tx,
        "collaborator",
        json!({
            "loop_item_id": issue_id,
            "user_id": user_id,
            "added_by_user_id": actor_id,
            "source": source,
        }),
    )
    .await?;
    Ok(())
}

pub(super) async fn sync(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    actor_id: i32,
    previous: Option<&Metadata>,
    next: &Metadata,
) -> MysqlResult<()> {
    let previous_people = previous.map_or(&[][..], |row| row.participants.as_slice());
    let previous_direct = previous.map_or(&[][..], Metadata::direct_people);
    if previous_people == next.participants && previous_direct == next.direct_people() {
        return Ok(());
    }
    let previous_people: HashSet<_> = previous_people.iter().copied().collect();
    let previous_direct: HashSet<_> = previous_direct.iter().copied().collect();
    let next_people: HashSet<_> = next.participants.iter().copied().collect();
    let next_direct: HashSet<_> = next.direct_people().iter().copied().collect();
    for &user_id in previous_people.difference(&next_people) {
        tx.execute(
            "DELETE FROM loop_items WHERE resource_type='collaborator' AND loop_item_id=? AND user_id=?",
            (issue_id, user_id),
        )
        .await?;
    }
    for &user_id in &next.participants {
        let source = source(&next_direct, user_id);
        if !previous_people.contains(&user_id) {
            insert(tx, issue_id, user_id, actor_id, source).await?;
        } else if previous_direct.contains(&user_id) != next_direct.contains(&user_id) {
            tx.execute(
                "UPDATE loop_items SET source=? WHERE resource_type='collaborator' AND loop_item_id=? AND user_id=?",
                (source, issue_id, user_id),
            ).await?;
        }
    }
    Ok(())
}

pub(super) async fn move_to_project(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    project_id: &str,
    owner_id: i32,
) -> MysqlResult<()> {
    tx.execute(
        "DELETE FROM loop_items WHERE resource_type='collaborator' AND loop_item_id=? AND user_id=?",
        (issue_id, owner_id),
    )
    .await?;
    tx.execute(
        "UPDATE loop_items SET cloud_project_id=?,source='manual' WHERE resource_type='collaborator' AND loop_item_id=?",
        (project_id, issue_id),
    )
    .await?;
    Ok(())
}
