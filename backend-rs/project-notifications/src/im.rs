// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider-neutral private-session IM delivery for board notifications.

use super::{IssueImRecipient, IssueImRecipientResolver};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlService};
use brz_redis::{Redis, RedisBytes};
use serde_json::{Value, json};

pub fn dingtalk_api_base(config: &Value) -> &str {
    config["api_base_url"]
        .as_str()
        .map(|value| value.trim_end_matches('/'))
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.dingtalk.com")
}

pub(super) async fn send_im(
    mysql: &MysqlService,
    redis: Option<&brz_redis::RedisService>,
    user: i64,
    notification: &Value,
    links: &[(String, String)],
    issue_im_recipient: Option<&dyn IssueImRecipientResolver>,
) -> Result<()> {
    let resolver = issue_im_recipient.filter(|_| {
        matches!(
            notification["kind"].as_str(),
            Some("issue_shared" | "issue_participation")
        )
    });
    let has_session = match redis {
        Some(redis) => send_private_sessions(mysql, redis, user, notification, links).await?,
        None if resolver.is_some() => false,
        None => bail!("Redis is unavailable"),
    };
    if !has_session
        && let Some(resolver) = resolver
        && let Some(recipient) = resolver.resolve(user).await?
    {
        send_to(mysql, Destination::Resolved(recipient), notification, links).await?;
    }
    Ok(())
}

async fn send_private_sessions(
    mysql: &MysqlService,
    redis: &brz_redis::RedisService,
    user: i64,
    notification: &Value,
    links: &[(String, String)],
) -> Result<bool> {
    let key = format!("channel:user_private_sessions:{user}");
    let sessions: Vec<String> = redis.zrevrange(key.as_str(), 0, -1).await?;
    let mut has_session = false;
    for session_key in sessions {
        let session = redis
            .get::<_, RedisBytes>(format!("channel:private_session:{session_key}"))
            .await?;
        let session = session
            .and_then(|bytes| serde_json::from_slice::<Value>(bytes.as_ref()).ok())
            .filter(|session| session.is_object());
        let Some(session) = session else {
            let _ = redis.zrem(key.as_str(), [session_key.as_str()]).await;
            continue;
        };
        if session["user_id"].as_i64() != Some(user) {
            continue;
        }
        has_session |= matches!(
            session["channel_type"].as_str(),
            Some("dingtalk" | "telegram" | "discord")
        );
        if let Err(error) =
            send_to(mysql, Destination::Session(&session), notification, links).await
        {
            tracing::warn!(user_id=user,channel_id=?session["channel_id"],channel_type=?session["channel_type"],%error,"private IM notification delivery failed");
        }
    }
    Ok(has_session)
}

enum Destination<'a> {
    Session(&'a Value),
    Resolved(IssueImRecipient),
}

#[derive(FromMysqlRow)]
struct Channel {
    json: Json<Value>,
}

/// Load the active Messager CRD spec a channel id refers to.
async fn active_channel_spec(mysql: &MysqlService, channel_id: i64) -> Result<Value> {
    let channel: Option<Channel> = mysql.fetch_optional("SELECT json FROM kinds WHERE id=? AND kind='Messager' AND user_id=0 AND is_active=true",(channel_id,)).await?;
    let channel = channel.context("Channel not found")?;
    Ok(channel.json.0["spec"].clone())
}

/// Decrypt the sensitive fields of a Messager channel's `spec.config`.
fn decrypt_channel_config(spec: &Value) -> Result<Value> {
    let mut config = spec["config"].as_object().cloned().unwrap_or_default();
    for (key, value) in &mut config {
        let lower = key.to_lowercase();
        if [
            "client_secret",
            "secret",
            "token",
            "access_token",
            "app_secret",
            "encrypt_key",
            "encoding_aes_key",
            "bot_token",
        ]
        .iter()
        .any(|part| lower.contains(part))
            && let Some(encrypted) = value.as_str().filter(|value| !value.is_empty())
        {
            *value = json!(
                wegent_identity::sensitive_data::decrypt_sensitive_data(encrypted)
                    .map_err(|_| anyhow::anyhow!("Channel credential decryption failed"))?
            );
        }
    }
    Ok(Value::Object(config))
}

/// Load a DingTalk channel's config after validating the Messager metadata.
///
/// `IMChannelAdapter` treats a missing `channelType` as `dingtalk` and a
/// missing `isEnabled` as enabled; the card transport must not borrow another
/// channel type's credential or drive a disabled channel.
pub async fn active_dingtalk_channel_config(
    mysql: &MysqlService,
    channel_id: i64,
) -> Result<Value> {
    let spec = active_channel_spec(mysql, channel_id).await?;
    let channel_type = spec
        .get("channelType")
        .and_then(Value::as_str)
        .unwrap_or("dingtalk");
    if channel_type != "dingtalk" {
        bail!("Channel {channel_id} is not a DingTalk channel");
    }
    if !messager_enabled(&spec) {
        bail!("DingTalk channel {channel_id} is disabled");
    }
    decrypt_channel_config(&spec)
}

/// `IMChannelAdapter.is_enabled`: `spec.get("isEnabled", True)`.
fn messager_enabled(spec: &Value) -> bool {
    match spec.get("isEnabled") {
        None => true,
        Some(Value::Null) => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => true,
    }
}

/// The DingTalk `client_id` / `client secret` pair used for the OpenAPI
/// token exchange (`DingTalkChannelProvider._is_configured`).
pub fn dingtalk_credentials(config: &Value) -> Option<(&str, &str)> {
    Some((
        config_value(config, &["client_id", "clientId"])?,
        config_value(config, &["client_secret", "clientSecret"])?,
    ))
}

/// One DingTalk OpenAPI access-token response.
pub struct DingTalkAccessToken {
    pub token: String,
    /// The `expireIn` seconds reported by the token endpoint.
    pub expires_in: i64,
}

/// `DingTalkCardTransport._access_token`: exchange a channel credential for an
/// OpenAPI access token. The caller owns any deadline or cache.
pub async fn dingtalk_access_token(
    client: &brz_http::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<DingTalkAccessToken> {
    dingtalk_access_token_at(client, client_id, client_secret, "https://api.dingtalk.com").await
}

async fn dingtalk_access_token_at(
    client: &brz_http::Client,
    client_id: &str,
    client_secret: &str,
    api: &str,
) -> Result<DingTalkAccessToken> {
    let access = http_json(
        client,
        &format!("{api}/v1.0/oauth2/accessToken"),
        None,
        &json!({"appKey":client_id,"appSecret":client_secret}),
    )
    .await?;
    let token = access["accessToken"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("DingTalk accessToken was not returned")?;
    let expires_in = access["expireIn"]
        .as_i64()
        .context("DingTalk accessToken expireIn was not returned")?;
    Ok(DingTalkAccessToken {
        token: token.to_owned(),
        expires_in,
    })
}

async fn send_to(
    mysql: &MysqlService,
    destination: Destination<'_>,
    notification: &Value,
    links: &[(String, String)],
) -> Result<()> {
    let kind = notification["kind"].as_str().unwrap_or("");
    let title = notification["title"].as_str().unwrap_or("");
    let body = notification["body"].as_str().unwrap_or("");
    let payload = &notification["payload"];
    let headline = push_headline(kind, title, payload);
    let title = headline.as_str();
    let facts = super::push_facts(payload);
    let mut lines: Vec<_> = facts
        .iter()
        .map(|(label, value)| format!("{label}：{value}"))
        .collect();
    if !body.trim().is_empty() {
        lines.push(if facts.is_empty() {
            body.trim().into()
        } else {
            format!("{}：{}", detail_label(payload), body.trim())
        });
    }
    let text = lines.join("\n\n");
    let plain = if text.is_empty() {
        title.to_owned()
    } else {
        format!("{title}\n\n{text}")
    };
    let plain = if links.is_empty() {
        plain
    } else {
        format!(
            "{plain}\n\n{}",
            links
                .iter()
                .map(|(_, url)| url.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let (recipient, expected_channel_type) = match destination {
        Destination::Resolved(recipient) => (recipient, None),
        Destination::Session(session) => match session["channel_type"].as_str().unwrap_or("") {
            "telegram" | "discord" => return send_text(mysql, session, &plain).await.map(|_| ()),
            "dingtalk" => (
                IssueImRecipient {
                    channel_id: session["channel_id"]
                        .as_i64()
                        .context("Missing IM channel id")?,
                    recipient_id: dingtalk_recipient(mysql, session).await?,
                },
                Some("dingtalk"),
            ),
            other => bail!("Unsupported channel type: {other}"),
        },
    };
    let spec = active_channel_spec(mysql, recipient.channel_id).await?;
    let channel_type = spec["channelType"].as_str().unwrap_or("dingtalk");
    if !messager_enabled(&spec) || expected_channel_type.is_some_and(|kind| kind != channel_type) {
        bail!("IM channel is disabled or does not match the session");
    }
    let config = decrypt_channel_config(&spec)?;
    let client = im_client()?;
    let id = &recipient.recipient_id;
    match channel_type {
        "dingtalk" => {
            dingtalk(
                &client, id, &config, kind, title, body, payload, &facts, &text, links,
            )
            .await
        }
        "telegram" => {
            let chat_id = id
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0)
                .context("Invalid Telegram private chat id")?;
            telegram_with_config(&client, &config, chat_id, None, &plain)
                .await
                .map(|_| ())
        }
        "discord" => discord_message(&client, &config, id, &plain)
            .await
            .map(|_| ()),
        other => bail!("Unsupported channel type: {other}"),
    }
}

fn config_value<'a>(config: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| config[*key].as_str().filter(|value| !value.is_empty()))
}
fn escape(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if "\\`*_~[]!<>".contains(character) {
            out.push('\\')
        }
        out.push(character)
    }
    out
}
fn detail_label(payload: &Value) -> &str {
    match payload["status"].as_str() {
        Some("completed") => "任务结果",
        Some("failed" | "FAILED") => "失败原因",
        Some("cancelled" | "CANCELLED") => "取消原因",
        _ => "说明",
    }
}

fn push_headline(kind: &str, title: &str, payload: &Value) -> String {
    match kind {
        "execution" => format!(
            "你的任务{}",
            super::execution_tail(payload["status"].as_str().unwrap_or(""))
        ),
        "mention" => payload["actorName"]
            .as_str()
            .map(|actor| format!("{actor} 在评论中提到了你"))
            .unwrap_or_else(|| title.into()),
        _ => title.into(),
    }
}

fn card_headline(kind: &str, title: &str, payload: &Value) -> String {
    let emoji = match payload["status"].as_str().unwrap_or("") {
        "completed" => "✅",
        "failed" | "FAILED" => "⚠️",
        "cancelled" | "CANCELLED" => "🚫",
        "queued" | "claimed" | "running" => "🚀",
        "pending_approval" => "⏳",
        "waiting_user_input" => "💬",
        "waiting_runtime" => "🖥️",
        _ => "ℹ️",
    };
    match kind {
        "execution" => format!("{emoji} {}", push_headline(kind, title, payload)),
        "mention" => format!("🔔 {}", push_headline(kind, title, payload)),
        "assignment" => payload["actorName"]
            .as_str()
            .map(|actor| format!("📌 {actor} 把任务分配给了你"))
            .unwrap_or_else(|| format!("📌 {title}")),
        "issue_dispatch_assignment" => payload["actorName"]
            .as_str()
            .map(str::trim)
            .filter(|actor| !actor.is_empty())
            .map(|actor| format!("{actor} 将任务分配给你"))
            .unwrap_or_else(|| "你收到一项任务".into()),
        _ => title.into(),
    }
}

async fn http_json(
    client: &brz_http::Client,
    url: &str,
    authorization: Option<(&str, &str)>,
    body: &Value,
) -> Result<Value> {
    let mut request = client
        .post(url)
        .map_err(|_| anyhow::anyhow!("Invalid IM endpoint"))?
        .header("content-type", "application/json")
        .json(body);
    if let Some((value, name)) = authorization {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("IM notification transport failed"))?;
    if !response.status().is_success() {
        bail!(
            "IM notification rejected with HTTP {}",
            response.status().as_u16()
        )
    }
    response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("IM notification returned invalid JSON"))
}

#[allow(clippy::too_many_arguments)]
async fn dingtalk(
    client: &brz_http::Client,
    recipient: &str,
    config: &Value,
    kind: &str,
    title: &str,
    body: &str,
    payload: &Value,
    facts: &[(String, String)],
    text: &str,
    links: &[(String, String)],
) -> Result<()> {
    let (client_id, client_secret) =
        dingtalk_credentials(config).context("Missing DingTalk credentials")?;
    let api = dingtalk_api_base(config);
    let access = dingtalk_access_token_at(client, client_id, client_secret, api).await?;
    if config["notification_card"].is_object() {
        const BUILTIN: &str = "1366a1eb-bc54-4859-ac88-517c56a9acb1.schema";
        let template = config["notification_card"]["template_id"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(BUILTIN);
        let headline = card_headline(kind, title, payload);
        let params = card_params(
            template == BUILTIN,
            kind,
            title,
            &headline,
            body,
            payload,
            facts,
            links,
        );
        let card = json!({"outTrackId":super::uuid(),"cardTemplateId":template,"openSpaceId":format!("dtv1.card//IM_ROBOT.{recipient}"),"cardData":{"cardParamMap":params},"imRobotOpenSpaceModel":{"supportForward":true,"lastMessageI18n":{"ZH_CN":headline}},"imRobotOpenDeliverModel":{"spaceType":"IM_ROBOT"}});
        match http_json(
            client,
            &format!("{api}/v1.0/card/instances/createAndDeliver"),
            Some((access.token.as_str(), "x-acs-dingtalk-access-token")),
            &card,
        )
        .await
        {
            Ok(value) if value.get("code").is_none() || value["code"] == "0" => return Ok(()),
            _ => {
                tracing::warn!("DingTalk AI notification card failed; using its markdown delivery")
            }
        }
    }
    let mut markdown = format!("**{}**\n\n{}", escape(title), escape(text));
    if !links.is_empty() {
        markdown.push_str(&format!(
            "\n\n{}",
            links
                .iter()
                .map(|(label, url)| format!("[{label}]({url})"))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }
    let parameters = serde_json::to_string(
        &json!({"title":title.chars().take(50).collect::<String>(),"text":markdown}),
    )?;
    http_json(client,&format!("{api}/v1.0/robot/oToMessages/batchSend"),Some((access.token.as_str(),"x-acs-dingtalk-access-token")),&json!({"robotCode":client_id,"userIds":[recipient],"msgKey":"sampleMarkdown","msgParam":parameters})).await?;
    Ok(())
}

// These fields mirror the two DingTalk card templates' distinct source inputs.
#[allow(clippy::too_many_arguments)]
fn card_params(
    builtin: bool,
    kind: &str,
    title: &str,
    headline: &str,
    body: &str,
    payload: &Value,
    facts: &[(String, String)],
    links: &[(String, String)],
) -> Value {
    let is_dispatch_assignment = kind == "issue_dispatch_assignment";
    let task_title = is_dispatch_assignment
        .then(|| payload["taskTitle"].as_str().unwrap_or("").trim())
        .filter(|title| !title.is_empty());
    if builtin {
        let mut lines: Vec<_> = facts
            .iter()
            .filter(|(label, _)| task_title.is_none() || label != "任务标题")
            .map(|(label, value)| format!("**{label}**：{}", escape(value)))
            .collect();
        if let Some(task_title) = task_title {
            lines.insert(0, format!("**任务标题**：{}", escape(task_title)));
        }
        if !body.is_empty() {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(format!("**{}**", detail_label(payload)));
            lines.extend(escape(body).lines().map(|line| format!("> {line}")));
        }
        let mut params = json!({"title":headline,"markdown":lines.join("\n"),"tips":""});
        if !links.is_empty() {
            let buttons:Vec<_>=links.iter().enumerate().map(|(index,(label,url))|json!({"text":label,"url":url,"color":if index==0{"blue"}else{"gray"}})).collect();
            params["sys_full_json_obj"] = json!(json!({"msgButtons":buttons}).to_string());
        }
        return params;
    }
    let primary = links
        .iter()
        .find(|(_, url)| url.starts_with("http://") || url.starts_with("https://"));
    let secondary = links.iter().find(|(_, url)| url.starts_with("wework://"));
    let detail = if body.chars().count() > 240 {
        format!("{}…", body.chars().take(239).collect::<String>())
    } else {
        body.into()
    };
    let meta = [
        payload["projectName"].as_str().unwrap_or(""),
        payload["itemStatus"].as_str().unwrap_or(""),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let (label, tone) = match kind {
        "mention" => ("评论提及", "blue"),
        "assignment" | "issue_dispatch_assignment" => ("任务分配", "blue"),
        "execution" => match payload["status"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "queued" => ("已入队", "blue"),
            "claimed" => ("准备执行", "blue"),
            "running" => ("执行中", "blue"),
            "pending_approval" => ("待审批", "orange"),
            "waiting_user_input" => ("待确认", "orange"),
            "waiting_runtime" => ("待选设备", "orange"),
            "completed" => ("已完成", "green"),
            "failed" => ("执行失败", "red"),
            "cancelled" => ("已取消", "gray"),
            _ => ("任务进展", "blue"),
        },
        _ => ("任务通知", "gray"),
    };
    let headline = if is_dispatch_assignment {
        headline
    } else {
        title
    };
    let item_title = task_title
        .or_else(|| payload["itemTitle"].as_str())
        .unwrap_or("");
    json!({"kindLabel":label,"tone":tone,"headline":headline,"itemTitle":item_title,"itemKey":payload["itemKey"].as_str().unwrap_or(""),"metaLine":meta,"detailLabel":detail_label(payload),"detail":detail,"showDetail":if body.is_empty(){"false"}else{"true"},"primaryLabel":primary.map(|value|value.0.as_str()).unwrap_or(""),"primaryUrl":primary.map(|value|value.1.as_str()).unwrap_or(""),"secondaryLabel":secondary.map(|value|value.0.as_str()).unwrap_or(""),"secondaryUrl":secondary.map(|value|value.1.as_str()).unwrap_or("")})
}

async fn dingtalk_recipient(mysql: &MysqlService, session: &Value) -> Result<String> {
    let mut recipient = session["proactive_recipient_id"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    if recipient.is_empty() {
        #[derive(FromMysqlRow)]
        struct Preferences {
            preferences: Option<String>,
        }
        let preferences: Option<Preferences> = mysql
            .fetch_optional(
                "SELECT preferences FROM users WHERE id=?",
                (session["user_id"].as_i64().unwrap_or(0),),
            )
            .await?;
        let preferences = preferences
            .and_then(|value| value.preferences)
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .unwrap_or(Value::Null);
        let channel = session["channel_id"].as_i64().unwrap_or(0).to_string();
        let binding = &preferences["im_channels"][channel];
        if binding["channel_type"] == session["channel_type"]
            && binding["last_conversation_id"] == session["conversation_id"]
        {
            recipient = binding["sender_staff_id"]
                .as_str()
                .unwrap_or("")
                .trim()
                .into();
        }
    }
    if recipient.is_empty() {
        bail!("Missing DingTalk staff ID")
    }
    Ok(recipient)
}

pub async fn send_text(mysql: &MysqlService, session: &Value, text: &str) -> Result<Value> {
    let channel_id = session["channel_id"]
        .as_i64()
        .context("Missing IM channel id")?;
    let kind = session["channel_type"]
        .as_str()
        .context("Missing IM channel type")?;
    if kind == "telegram" {
        let chat_id = session["sender_id"]
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
            .context("Missing Telegram chat id")?;
        return telegram_message(mysql, channel_id, chat_id, None, text).await;
    }
    let spec = active_channel_spec(mysql, channel_id).await?;
    if spec["channelType"].as_str().unwrap_or("dingtalk") != kind || !messager_enabled(&spec) {
        bail!("IM channel type or status does not match the session");
    }
    let config = decrypt_channel_config(&spec)?;
    let client = im_client()?;
    match kind {
        "discord" => {
            let recipient = session["sender_id"]
                .as_str()
                .context("Missing Discord user id")?;
            discord_message(&client, &config, recipient, text).await
        }
        "dingtalk" => {
            let (id, secret) =
                dingtalk_credentials(&config).context("Missing DingTalk credentials")?;
            let recipient = dingtalk_recipient(mysql, session).await?;
            // Honor the same channel endpoint configuration as subscription delivery.
            let api = dingtalk_api_base(&config);
            let access = dingtalk_access_token_at(&client, id, secret, api).await?;
            http_json(&client, &format!("{api}/v1.0/robot/oToMessages/batchSend"),
                Some((&access.token, "x-acs-dingtalk-access-token")),
                &json!({"robotCode":id,"userIds":[recipient],"msgKey":"sampleText","msgParam":json!({"content":text}).to_string()})).await
        }
        _ => bail!("Unsupported channel type"),
    }
}

async fn discord_message(
    client: &brz_http::Client,
    config: &Value,
    recipient_id: &str,
    text: &str,
) -> Result<Value> {
    let token =
        config_value(config, &["bot_token", "botToken"]).context("Missing Discord bot token")?;
    if recipient_id.is_empty() {
        bail!("Missing Discord user id");
    }
    let auth = format!("Bot {token}");
    let dm = http_json(
        client,
        "https://discord.com/api/v10/users/@me/channels",
        Some((&auth, "authorization")),
        &json!({"recipient_id":recipient_id}),
    )
    .await?;
    let channel = dm["id"]
        .as_str()
        .context("Discord DM channel not returned")?;
    let content = if text.chars().count() > 2000 {
        format!("{}...", text.chars().take(1997).collect::<String>())
    } else {
        text.to_owned()
    };
    http_json(
        client,
        &format!("https://discord.com/api/v10/channels/{channel}/messages"),
        Some((&auth, "authorization")),
        &json!({"content":content}),
    )
    .await
}

fn im_client() -> Result<brz_http::Client> {
    brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| anyhow::anyhow!("IM HTTP client initialization failed"))
}

pub async fn telegram_message(
    mysql: &MysqlService,
    channel_id: i64,
    chat_id: i64,
    message_id: Option<i64>,
    text: &str,
) -> Result<Value> {
    let spec = active_channel_spec(mysql, channel_id).await?;
    if spec["channelType"] != "telegram" || !messager_enabled(&spec) {
        bail!("Telegram channel is unavailable");
    }
    let config = decrypt_channel_config(&spec)?;
    telegram_with_config(&im_client()?, &config, chat_id, message_id, text).await
}

async fn telegram_with_config(
    client: &brz_http::Client,
    config: &Value,
    chat_id: i64,
    message_id: Option<i64>,
    text: &str,
) -> Result<Value> {
    let token =
        config_value(config, &["bot_token", "botToken"]).context("Missing Telegram bot token")?;
    let endpoint = format!("https://api.telegram.org/bot{token}");
    send_telegram(client, &endpoint, chat_id, message_id, text).await
}

async fn send_telegram(
    client: &brz_http::Client,
    endpoint: &str,
    chat_id: i64,
    message_id: Option<i64>,
    text: &str,
) -> Result<Value> {
    let (method, body) = telegram_request(chat_id, message_id, text);
    let url = format!("{endpoint}/{method}");
    for attempt in 1..=3 {
        let response = client
            .post(&url)
            .map_err(|_| anyhow::anyhow!("Invalid Telegram endpoint"))?
            .json(&body)
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let value: Value = response.json().await.unwrap_or(Value::Null);
                if (200..300).contains(&status) && value["ok"] == true {
                    return Ok(value["result"].clone());
                }
                if message_id.is_some()
                    && status == 400
                    && value["description"]
                        .as_str()
                        .is_some_and(|description| description.contains("message is not modified"))
                {
                    return Ok(json!({"message_id": message_id}));
                }
                if !(500..600).contains(&status) || attempt == 3 {
                    bail!("Telegram request rejected with HTTP {status}");
                }
            }
            Err(_) if attempt == 3 => bail!("Telegram transport failed"),
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
    }
    bail!("Telegram transport failed")
}

fn telegram_request(chat_id: i64, message_id: Option<i64>, text: &str) -> (&'static str, Value) {
    let text = text.chars().take(4096).collect::<String>();
    if let Some(message_id) = message_id {
        (
            "editMessageText",
            json!({"chat_id":chat_id, "message_id":message_id, "text":text}),
        )
    } else {
        ("sendMessage", json!({"chat_id":chat_id, "text":text}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dingtalk_endpoint_matches_subscription_channel_configuration() {
        for config in [
            json!({}),
            json!({"api_base_url": ""}),
            json!({"api_base_url": "/"}),
        ] {
            assert_eq!(dingtalk_api_base(&config), "https://api.dingtalk.com");
        }
        assert_eq!(
            dingtalk_api_base(&json!({"api_base_url": "http://127.0.0.1:1234///"})),
            "http://127.0.0.1:1234"
        );
    }
    #[test]
    fn notifications_escape_member_markdown_without_changing_plain_punctuation() {
        assert_eq!(escape("[x] *a* - 2026"), "\\[x\\] \\*a\\* - 2026");
    }
    #[test]
    fn a_messager_channel_is_enabled_unless_it_is_explicitly_disabled() {
        assert!(messager_enabled(&json!({})));
        assert!(messager_enabled(&json!({"isEnabled": true})));
        assert!(!messager_enabled(&json!({"isEnabled": false})));
        assert!(!messager_enabled(&json!({"isEnabled": null})));
    }
    #[test]
    fn channel_credentials_come_from_the_messager_config() {
        let config = json!({
            "client_id": "client-id",
            "client_secret": "client-secret",
        });
        assert_eq!(
            dingtalk_credentials(&config),
            Some(("client-id", "client-secret"))
        );
        assert_eq!(
            dingtalk_credentials(&json!({"client_id": "client-id"})),
            None
        );
    }
    #[test]
    fn assignment_cards_show_the_assigner_above_the_dispatched_task() {
        let kind = "issue_dispatch_assignment";
        let title = "新任务：验收登录";
        let payload =
            json!({"actorName": "项目经理", "taskTitle": "验收登录", "itemTitle": "修复登录"});
        let headline = card_headline(kind, title, &payload);
        let facts = super::super::push_facts(&payload);

        let custom = card_params(false, kind, title, &headline, "", &payload, &facts, &[]);
        let builtin = card_params(true, kind, title, &headline, "", &payload, &facts, &[]);

        assert_eq!(custom["headline"], "项目经理 将任务分配给你");
        assert_eq!(custom["itemTitle"], "验收登录");
        assert_eq!(builtin["title"], custom["headline"]);
        assert_eq!(builtin["markdown"], "**任务标题**：验收登录");
        assert_eq!(
            card_headline(kind, title, &json!({"actorName": " "})),
            "你收到一项任务"
        );
    }

    #[test]
    fn custom_cards_limit_detail_and_expose_each_destination() {
        let value = card_params(
            false,
            "assignment",
            "t",
            "t",
            &"a".repeat(241),
            &json!({}),
            &[],
            &[
                ("web".into(), "https://example.invalid".into()),
                ("app".into(), "wework://boards/p".into()),
            ],
        );
        assert_eq!(value["detail"].as_str().unwrap().chars().count(), 240);
        assert_eq!(value["primaryUrl"], "https://example.invalid");
        assert_eq!(value["secondaryUrl"], "wework://boards/p");
    }
}

#[cfg(test)]
mod telegram_protocol_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn telegram_send_and_edit_use_the_bot_api_message_identity() {
        for (message_id, method) in [(None, "sendMessage"), (Some(21), "editMessageText")] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}/bot-test", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (offset, size) = loop {
                    let mut buf = [0; 1024];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0);
                    request.extend_from_slice(&buf[..n]);
                    if let Some(position) =
                        request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                    {
                        let headers = String::from_utf8_lossy(&request[..position]);
                        assert!(headers.starts_with(&format!("POST /bot-test/{method} HTTP/1.1")));
                        let size = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (position + 4, size);
                    }
                };
                while request.len() < offset + size {
                    let mut buf = [0; 1024];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0);
                    request.extend_from_slice(&buf[..n]);
                }
                let body: Value = serde_json::from_slice(&request[offset..offset + size]).unwrap();
                assert_eq!(body["chat_id"], -12);
                assert_eq!(body["text"], "Runtime reply");
                assert_eq!(body["message_id"], json!(message_id));
                let response = r#"{"ok":true,"result":{"message_id":21}}"#;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            });
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                send_telegram(
                    &im_client().unwrap(),
                    &endpoint,
                    -12,
                    message_id,
                    "Runtime reply",
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(result["message_id"], 21);
            server.await.unwrap();
        }
    }
}

#[cfg(test)]
mod dingtalk_protocol_tests {
    use super::*;
    use brz_http_server::{Handler, NoAuthenticator, Request, Response, StatusCode};
    use std::sync::{Arc, Mutex};

    const ISSUE_LINK: &str = "[在 Wework 中打开](wework://personal-issues/share-1-test)";

    struct DingTalkApi {
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        reject_card: bool,
    }

    impl Handler for DingTalkApi {
        async fn call<'a>(&'a self, request: Request<'a>, _: &'a NoAuthenticator) -> Response {
            assert_eq!(request.method(), "POST");
            let body: Value = serde_json::from_slice(request.body()).unwrap();
            let path = request.path();
            let response = if path == "/v1.0/oauth2/accessToken" {
                assert_eq!(body, json!({"appKey":"ci-app","appSecret":"ci-secret"}));
                br#"{"accessToken":"ci-token","expireIn":7200}"#.as_slice()
            } else {
                assert_eq!(
                    request.header("x-acs-dingtalk-access-token"),
                    Some(b"ci-token".as_slice())
                );
                match path {
                    "/v1.0/card/instances/createAndDeliver" if self.reject_card => {
                        br#"{"code":"rejected"}"#.as_slice()
                    }
                    "/v1.0/card/instances/createAndDeliver" => {
                        assert_eq!(body["openSpaceId"], "dtv1.card//IM_ROBOT.ci-staff");
                        let buttons: Value = serde_json::from_str(
                            body["cardData"]["cardParamMap"]["sys_full_json_obj"]
                                .as_str()
                                .unwrap(),
                        )
                        .unwrap();
                        assert_eq!(
                            buttons["msgButtons"][0]["url"],
                            "wework://personal-issues/share-1-test"
                        );
                        br#"{"code":"0"}"#.as_slice()
                    }
                    "/v1.0/robot/oToMessages/batchSend" => {
                        assert_eq!(body["robotCode"], "ci-app");
                        assert_eq!(body["userIds"], json!(["ci-staff"]));
                        assert_eq!(body["msgKey"], "sampleMarkdown");
                        let params: Value =
                            serde_json::from_str(body["msgParam"].as_str().unwrap()).unwrap();
                        let text = params["text"].as_str().unwrap();
                        assert!(text.contains("CI notification"));
                        assert!(text.contains(ISSUE_LINK));
                        br#"{"processQueryKey":"ci-message"}"#.as_slice()
                    }
                    _ => panic!("Unexpected DingTalk API request: {path}"),
                }
            };
            self.requests.lock().unwrap().push((path.to_owned(), body));
            Response::static_bytes(StatusCode::OK, response).content_type("application/json")
        }
    }

    #[tokio::test]
    async fn structured_notifications_use_the_configured_host_for_auth_cards_and_markdown() {
        for (card, reject_card) in [(false, false), (true, false), (true, true)] {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let server = brz_http_server::Server::bind(
                "127.0.0.1:0".parse().unwrap(),
                DingTalkApi {
                    requests: requests.clone(),
                    reject_card,
                },
            )
            .await
            .unwrap();
            let api = format!("http://{}/", server.local_addr().unwrap());
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(server.serve_until(async {
                let _ = stopped.await;
            }));
            let mut config =
                json!({"client_id":"ci-app","client_secret":"ci-secret","api_base_url":api});
            if card {
                config["notification_card"] = json!({});
            }
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                dingtalk(
                    &im_client().unwrap(),
                    "ci-staff",
                    &config,
                    "issue_shared",
                    "CI title",
                    "CI notification",
                    &json!({"personalIssueId": "share-1-test"}),
                    &[],
                    "CI notification",
                    &[(
                        "在 Wework 中打开".into(),
                        "wework://personal-issues/share-1-test".into(),
                    )],
                ),
            )
            .await;
            let _ = stop.send(());
            task.await.unwrap().unwrap();
            result
                .expect("DingTalk protocol request timed out")
                .unwrap();
            let paths: Vec<String> = requests
                .lock()
                .unwrap()
                .iter()
                .map(|(path, _)| path.clone())
                .collect();
            let mut expected = vec!["/v1.0/oauth2/accessToken"];
            if card {
                expected.push("/v1.0/card/instances/createAndDeliver");
            }
            if !card || reject_card {
                expected.push("/v1.0/robot/oToMessages/batchSend");
            }
            assert_eq!(paths, expected);
        }
    }
}
