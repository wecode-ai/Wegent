// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider-neutral private-session IM delivery for board notifications.

use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json};
use brz_redis::{Redis, RedisBytes};
use serde_json::{Value, json};

pub(crate) async fn send_im(
    state: &AppState,
    user: i64,
    kind: &str,
    title: &str,
    body: &str,
    payload: &Value,
    links: &[(String, String)],
) -> Result<()> {
    let redis = state.redis.as_ref().context("Redis is unavailable")?;
    let key = format!("channel:user_private_sessions:{user}");
    let sessions: Vec<String> = redis.zrevrange(key.as_str(), 0, -1).await?;
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
        if let Err(error) = send_session(state, &session, kind, title, body, payload, links).await {
            tracing::warn!(user_id=user,channel_id=?session["channel_id"],channel_type=?session["channel_type"],%error,"private IM notification delivery failed");
        }
    }
    Ok(())
}

#[derive(FromMysqlRow)]
struct Channel {
    json: Json<Value>,
}

async fn send_session(
    state: &AppState,
    session: &Value,
    kind: &str,
    title: &str,
    body: &str,
    payload: &Value,
    links: &[(String, String)],
) -> Result<()> {
    let channel:Option<Channel>=state.mysql.fetch_optional("SELECT json FROM kinds WHERE id=? AND kind='Messager' AND user_id=0 AND is_active=true",(session["channel_id"].as_i64().unwrap_or(0),)).await?;
    let channel = channel.context("Channel not found")?;
    let mut config = channel.json.0["spec"]["config"]
        .as_object()
        .cloned()
        .unwrap_or_default();
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
                crate::subscriptions_item::crypto::decrypt_sensitive_data(encrypted)
                    .map_err(|_| anyhow::anyhow!("Channel credential decryption failed"))?
            );
        }
    }
    let config = Value::Object(config);
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
    let client = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| anyhow::anyhow!("IM HTTP client initialization failed"))?;
    match session["channel_type"].as_str().unwrap_or("") {
        "telegram" => {
            let token = config_value(&config, &["bot_token", "botToken"])
                .context("Missing Telegram bot token")?;
            let sender = session["sender_id"]
                .as_str()
                .and_then(|value| value.parse::<i64>().ok())
                .context("Missing Telegram chat id")?;
            let url = format!("https://api.telegram.org/bot{token}/sendMessage");
            for attempt in 1..=3 {
                let response = client
                    .post(&url)
                    .map_err(|_| anyhow::anyhow!("Invalid Telegram endpoint"))?
                    .json(&json!({"chat_id":sender,"text":plain}))
                    .send()
                    .await;
                match response {
                    Ok(response) => {
                        let status = response.status().as_u16();
                        let value: Value = response.json().await.unwrap_or(Value::Null);
                        if (200..300).contains(&status) && value["ok"] == true {
                            return Ok(());
                        }
                        if !(500..600).contains(&status) || attempt == 3 {
                            bail!("Telegram notification rejected with HTTP {status}")
                        }
                    }
                    Err(_) if attempt == 3 => bail!("Telegram notification transport failed"),
                    Err(_) => {}
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
            }
            Ok(())
        }
        "discord" => {
            let token = config_value(&config, &["bot_token", "botToken"])
                .context("Missing Discord bot token")?;
            let sender = session["sender_id"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("Missing Discord user id")?;
            let auth = format!("Bot {token}");
            let dm = http_json(
                &client,
                "https://discord.com/api/v10/users/@me/channels",
                Some((&auth, "authorization")),
                &json!({"recipient_id":sender}),
            )
            .await?;
            let channel = dm["id"]
                .as_str()
                .context("Discord DM channel not returned")?;
            let content = if plain.chars().count() > 2000 {
                format!("{}...", plain.chars().take(1997).collect::<String>())
            } else {
                plain
            };
            http_json(
                &client,
                &format!("https://discord.com/api/v10/channels/{channel}/messages"),
                Some((&auth, "authorization")),
                &json!({"content":content}),
            )
            .await?;
            Ok(())
        }
        "dingtalk" => {
            dingtalk(
                state, &client, session, &config, kind, title, body, payload, &facts, &text, links,
            )
            .await
        }
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
    state: &AppState,
    client: &brz_http::Client,
    session: &Value,
    config: &Value,
    kind: &str,
    title: &str,
    body: &str,
    payload: &Value,
    facts: &[(String, String)],
    text: &str,
    links: &[(String, String)],
) -> Result<()> {
    let client_id =
        config_value(config, &["client_id", "clientId"]).context("Missing DingTalk credentials")?;
    let client_secret = config_value(config, &["client_secret", "clientSecret"])
        .context("Missing DingTalk credentials")?;
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
        let preferences: Option<Preferences> = state
            .mysql
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
    let access = http_json(
        client,
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        None,
        &json!({"appKey":client_id,"appSecret":client_secret}),
    )
    .await?;
    let access = access["accessToken"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("DingTalk accessToken was not returned")?;
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
            "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
            Some((access, "x-acs-dingtalk-access-token")),
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
    http_json(client,"https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",Some((access,"x-acs-dingtalk-access-token")),&json!({"robotCode":client_id,"userIds":[recipient],"msgKey":"sampleMarkdown","msgParam":parameters})).await?;
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
    if builtin {
        let mut lines: Vec<_> = facts
            .iter()
            .map(|(label, value)| format!("**{label}**：{}", escape(value)))
            .collect();
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
    json!({"kindLabel":label,"tone":tone,"headline":title,"itemTitle":payload["itemTitle"].as_str().unwrap_or(""),"itemKey":payload["itemKey"].as_str().unwrap_or(""),"metaLine":meta,"detailLabel":detail_label(payload),"detail":detail,"showDetail":if body.is_empty(){"false"}else{"true"},"primaryLabel":primary.map(|value|value.0.as_str()).unwrap_or(""),"primaryUrl":primary.map(|value|value.1.as_str()).unwrap_or(""),"secondaryLabel":secondary.map(|value|value.0.as_str()).unwrap_or(""),"secondaryUrl":secondary.map(|value|value.1.as_str()).unwrap_or("")})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notifications_escape_member_markdown_without_changing_plain_punctuation() {
        assert_eq!(escape("[x] *a* - 2026"), "\\[x\\] \\*a\\* - 2026");
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
