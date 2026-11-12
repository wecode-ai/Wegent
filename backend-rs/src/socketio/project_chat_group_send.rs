//! Group discussion commits current authority, messages, reminders and wakeups together.
use std::collections::BTreeSet;

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

use super::{SendRequest, ack_error, reply};
use crate::background_jobs::project::{notifications, store};
use crate::chat_groups::{internal, participant_id, reject, repository};
use crate::socketio::project_chat_mentions::{Mention, preview};
use crate::socketio::project_chat_messages::{
    INSERT_MESSAGE_SQL, InsertMessage, MESSAGE_COLUMNS, MessageRow, insert_message_args,
    message_view, uuid4,
};
use crate::state::AppState;

#[derive(FromMysqlRow)]
struct Participation {
    metadata: Option<Json<Value>>,
}

async fn participants(
    tx: &mut impl MysqlTransaction,
    thread: &str,
    members: &BTreeSet<i32>,
) -> MysqlResult<(BTreeSet<i32>, BTreeSet<i32>)> {
    let mut joined = BTreeSet::new();
    let mut subscribed = BTreeSet::new();
    for user in members {
        let row: Option<Participation> = tx.fetch_optional(
            format!("SELECT metadata FROM loop_items WHERE id=? AND resource_type='thread_participant' AND parent_id=? AND user_id=? AND status='active' AND {} FOR UPDATE",store::LIVE),
            (participant_id(thread,*user),thread,*user),
        ).await?;
        if let Some(row) = row {
            joined.insert(*user);
            if row
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.0["notifications"].as_str())
                .unwrap_or("all")
                == "all"
            {
                subscribed.insert(*user);
            }
        }
    }
    Ok((joined, subscribed))
}

async fn validate_mentions(
    tx: &mut impl MysqlTransaction,
    request: &SendRequest,
    actor: i32,
    members: &BTreeSet<i32>,
    mentions: &[Mention],
) -> MysqlResult<BTreeSet<i32>> {
    let mut users = BTreeSet::new();
    for mention in mentions {
        if mention.is_user() {
            let user = mention
                .id()
                .parse::<i32>()
                .ok()
                .filter(|user| user.to_string() == mention.id() && members.contains(user))
                .ok_or_else(|| reject(422, "Mentioned user is not a current group member"))?;
            users.insert(user);
        } else {
            let agent: Option<(String,)> = tx.fetch_optional(
                format!("SELECT id FROM loop_items WHERE id=? AND resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {} AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.visibility')),'shared')<>'private' OR created_by_user_id=?) FOR UPDATE",store::LIVE),
                (mention.id(),request.project_id.as_str(),actor),
            ).await?;
            if agent.is_none() {
                return Err(reject(409, "Mentioned AI is not available in this group"));
            }
        }
    }
    Ok(users)
}

async fn reply_context(
    tx: &mut impl MysqlTransaction,
    request: &SendRequest,
) -> MysqlResult<reply::Context> {
    let Some(target) = request.reply_to_message_id.as_deref() else {
        return Ok(reply::Context::default());
    };
    let row: Option<MessageRow> = tx.fetch_optional(
        format!("SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE message_id=? AND project_id=? AND {} FOR UPDATE",store::LIVE),
        (target,request.project_id.as_str()),
    ).await?;
    let row = row.ok_or_else(|| reject(404, "Reply message not found"))?;
    reply::from_target(request, &row).map_err(|error| {
        reject(
            422,
            error["error"]["message"]
                .as_str()
                .unwrap_or("Invalid reply target"),
        )
    })
}

pub(super) async fn send_message(
    state: &AppState,
    user: i64,
    user_name: &str,
    request: &SendRequest,
) -> Result<(Value, bool), Value> {
    let actor =
        i32::try_from(user).map_err(|_| ack_error("SCOPE_NOT_FOUND", "Chat group not found"))?;
    let result = crate::transaction_outcome::run_mysql_with_deadlock_retry(&state.mysql, async |tx| {
        let (group, members) = repository::lock_message_authority(tx, &request.project_id, actor).await?;
        let thread: Option<store::Node> = if let Some(id) = request.task_id.as_deref() {
            Some(tx.fetch_optional(
                format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND cloud_project_id=? AND {} FOR UPDATE",store::COLUMNS,store::LIVE),
                (id,request.project_id.as_str()),
            ).await?.ok_or_else(|| reject(404,"Thread not found"))?)
        } else { None };
        let (joined, subscribers) = if let Some(thread) = &thread {
            let participation = participants(tx, &thread.id, &members).await?;
            if !participation.0.contains(&actor) {
                return Err(reject(403,"Join the Thread before participating"));
            }
            participation
        } else { (members.clone(),BTreeSet::new()) };
        let existing: Option<MessageRow> = tx.fetch_optional(
            format!("SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE sender_type='user' AND sender_id=? AND client_message_id=? FOR UPDATE"),
            (actor.to_string(),request.client_message_id.as_str()),
        ).await?;
        if let Some(existing) = existing {
            if existing.project_id != request.project_id || existing.task_id != request.task_id.as_deref().unwrap_or_default() {
                return Err(reject(409,"Client message identity belongs to another conversation"));
            }
            return Ok((existing, Vec::new(), false));
        }
        let context = reply_context(tx,request).await?;
        let mut mentions = request.mentions.clone();
        let mut metadata = Map::new();
        context.apply_stand_in(&mut mentions,&mut metadata);
        let mentioned = validate_mentions(tx,request,actor,&members,&mentions).await?;
        metadata.insert("mentions".into(),json!(mentions));
        if !mentions.is_empty() && mentions.iter().all(Mention::is_user) {
            metadata.insert("execution_dispatch".into(),json!("comment_only"));
        }
        if let Some(model) = &request.model { metadata.insert("model".into(),json!(model)); }
        let message_id=uuid4();
        let actor_id=actor.to_string();
        let message=InsertMessage {
            message_id:&message_id,client_message_id:&request.client_message_id,
            project_id:&request.project_id,task_id:request.task_id.as_deref().unwrap_or_default(),
            sender_type:"user",sender_id:&actor_id,sender_name:user_name,message_type:"text",
            content:&request.content,metadata:Value::Object(metadata),trigger_message_id:"",
            reply_to_message_id:context.reply_to.as_deref().unwrap_or_default(),
            thread_root_message_id:context.root.as_deref().unwrap_or_default(),
            agent_id:"",runtime_device_id:"",runtime_task_id:"",runtime_activity_key:"",status:"completed",
        };
        let inserted=tx.execute(INSERT_MESSAGE_SQL,insert_message_args(&message)).await?;
        let mut target=json!({"projectId":group.id,"groupId":group.id,"projectName":group.name,"actorName":user_name,"commentId":message_id,"commentPreview":preview(&request.content)});
        if let Some(thread)=&thread {
            target["itemId"]=json!(thread.id);
            target["itemTitle"]=json!(thread.title);
        }
        if let Some(preview)=context.preview { target["replyPreview"]=json!(preview); }
        let recipients=if thread.is_some() {subscribers} else {mentioned.clone()};
        let mut pending=Vec::new();
        for recipient in recipients.into_iter().filter(|recipient| *recipient != actor) {
            let mentioned=mentioned.contains(&recipient);
            let kind=if mentioned {"mention"} else {"thread_message"};
            let title=if mentioned {format!("{user_name} 提到了你")} else {format!("{user_name} 在 Thread 中发了新消息")};
            pending.push(notifications::create_on(tx,state,i64::from(recipient),user,kind,&title,&preview(&request.content),target.clone()).await?);
        }
        if let Some(thread)=thread {
            let mut metadata=thread.meta();
            crate::background_jobs::project::issues::update_change_request_source(&mut metadata,&format!("activity:{message_id}"),&request.content);
            crate::socketio::project_chat_snapshot::advance_content_revision(metadata.as_object_mut().expect("normalized metadata"),user);
            tx.execute("UPDATE loop_items SET metadata=?,version=version+1 WHERE id=?",(Json(metadata),thread.id.as_str())).await?;
            for recipient in mentioned.intersection(&joined) {
                crate::stand_in_issue_events::enqueue_mention_on(tx,i64::from(*recipient),&request.project_id,&thread.id,&message_id).await?;
            }
        }
        let saved=tx.fetch_optional(format!("SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE id=?"),(inserted.last_insert_id as i64,)).await?.ok_or(brz_mysql::MysqlError::RowNotFound)?;
        Ok((saved,pending,true))
    }).await.map_err(|error| {
        let error=internal(error);
        let code=match error.status().as_u16() {403=>"SCOPE_FORBIDDEN",404=>"SCOPE_NOT_FOUND",409=>"MESSAGE_CONFLICT",422=>"INVALID_MESSAGE",_=>"INTERNAL_ERROR"};
        ack_error(code,error.detail_message().unwrap_or("Group message could not be saved"))
    })?;
    let (saved, pending, created) = result;
    for notification in pending {
        notifications::deliver(state, notification).await;
    }
    Ok((message_view(&saved), created))
}
