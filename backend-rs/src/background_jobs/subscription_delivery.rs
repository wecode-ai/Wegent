//! Subscription follower selection and webhook protocols. Delivery is supplementary.
use super::model::{self, Execution};
use crate::AppState;
use anyhow::{Context, Result, bail};
use base64::Engine;
use brz_mysql::{FromMysqlRow, Json};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

#[derive(FromMysqlRow)]
struct Follow {
    follower_user_id: i64,
    config: Option<String>,
}
#[derive(FromMysqlRow)]
struct User {
    preferences: Option<String>,
}
#[derive(FromMysqlRow)]
struct Channel {
    json: Json<Value>,
}

pub(crate) async fn notify(
    app: &AppState,
    execution: &Execution,
    status: &str,
    summary: &str,
) -> Result<()> {
    // `_dispatch_notifications` (`task_completion_handler.py:524-529`) reads the
    // active subscription, then resolves the Team its `teamRef` names
    // (`:552-562`). The source builds a `subscription_info` string from the team
    // display name and never uses it, but the read stays part of the block.
    let Some(subscription) =
        model::subscription(&app.mysql, execution.subscription_id, true).await?
    else {
        return Ok(());
    };
    if let Some(team_ref) = subscription.json.0["spec"]["teamRef"].as_object()
        && let (Some(team_name), Some(namespace)) = (
            team_ref.get("name").and_then(|value| value.as_str()),
            team_ref.get("namespace").and_then(|value| value.as_str()),
        )
    {
        let _display_name: Option<brz_mysql::MysqlRow> = app
            .mysql
            .fetch_optional(model::team_display_statement(), (team_name, namespace))
            .await?;
    }
    let name = subscription.json.0["spec"]["displayName"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(&subscription.name);
    let message = public_links(app, &format_message(name, status, summary))?;
    let http = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let followers: Vec<Follow> = app
        .mysql
        .fetch_all(model::accepted_followers_statement(), (subscription.id,))
        .await?;
    for follower in followers {
        let config = follower
            .config
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
        if config["notification_level"] != "notify" {
            continue;
        }
        let user: Option<User> = app
            .mysql
            .fetch_optional(
                "SELECT preferences FROM users WHERE id=?",
                (follower.follower_user_id,),
            )
            .await?;
        let bindings = user
            .and_then(|u| u.preferences)
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        for channel_id in config["notification_channel_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
        {
            let binding = &bindings["im_channels"][channel_id.to_string()];
            if !binding.is_object() {
                continue;
            }
            let channel: Option<Channel> = app
                .mysql
                .fetch_optional(
                    "SELECT json FROM kinds WHERE id=? AND kind='Messager' AND is_active=1",
                    (channel_id,),
                )
                .await?;
            let Some(channel) = channel else { continue };
            let spec = &channel.json.0["spec"];
            let result = match spec["channelType"].as_str() {
                Some("dingtalk") => {
                    let binding_config = if follower.follower_user_id == subscription.user_id {
                        subscription.json.0["_internal"]["notification_channel_bindings"]
                            [channel_id.to_string()]
                        .clone()
                    } else {
                        Value::Null
                    };
                    dingtalk(
                        app,
                        &http,
                        &spec["config"],
                        binding,
                        &binding_config,
                        name,
                        &message,
                    )
                    .await
                }
                Some("telegram") => telegram(&http, &spec["config"], binding, name, &message).await,
                _ => Ok(()),
            };
            if let Err(error) = result {
                tracing::warn!(execution_id=execution.id,channel_id,%error,"subscription follower notification failed")
            }
        }
    }
    for target in subscription.json.0["spec"]["notificationWebhooks"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if target["enabled"] == false {
            continue;
        }
        if let Err(error) = webhook(&http, target, name, status, &message).await {
            tracing::warn!(execution_id=execution.id,%error,"subscription webhook notification failed")
        }
    }
    Ok(())
}
fn format_message(name: &str, status: &str, summary: &str) -> String {
    if status == "COMPLETED" {
        return summary.into();
    }
    let mut preview = summary.chars().take(300).collect::<String>();
    if summary.chars().count() > 300 {
        preview.push_str("...")
    }
    format!(
        "📬 订阅任务通知\n\n**订阅**: {name}\n\n**状态**: ❌ 执行失败\n\n**错误信息**:\n\n\n{preview}"
    )
}
fn public_links(app: &AppState, text: &str) -> Result<String> {
    let regex = regex::Regex::new(r"/api/attachments/(\d+)/download")?;
    let frontend = crate::config::env_or_dotenv("FRONTEND_URL")
        .unwrap_or_else(|| "http://localhost:3000".into());
    let external = crate::config::env_or_dotenv("TASK_NOTIFICATION_URL").filter(|v| !v.is_empty());
    let mut result = String::new();
    let mut offset = 0;
    for captures in regex.captures_iter(text) {
        let m = captures.get(0).unwrap();
        result.push_str(&text[offset..m.start()]);
        let id = captures[1].parse::<i64>()?;
        let token = crate::attachments::public_link::generate_public_attachment_token(
            &app.auth,
            id,
            chrono::Duration::days(7),
            Utc::now(),
        )?;
        let inner = format!(
            "{}/download/shared?token={token}",
            frontend.trim_end_matches('/')
        );
        let url = if let Some(external) = external.as_ref() {
            let outer = format!(
                "{}/download/shared?token={token}",
                external.trim_end_matches('/')
            );
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("target", "download/shared")
                .append_pair("token", &token)
                .append_pair("inner", &inner)
                .append_pair("outer", &outer)
                .finish();
            format!("{}/jump?{query}", external.trim_end_matches('/'))
        } else {
            inner
        };
        result.push_str(&url);
        offset = m.end();
    }
    result.push_str(&text[offset..]);
    Ok(result)
}
fn secret(value: &Value, key: &str) -> Result<String> {
    let Some(raw) = value[key].as_str().filter(|v| !v.is_empty()) else {
        return Ok(String::new());
    };
    crate::subscriptions_item::crypto::decrypt_sensitive_data(raw)
        .map_err(|_| anyhow::anyhow!("Notification credential decryption failed"))
}
async fn post(
    http: &brz_http::Client,
    url: &str,
    payload: &Value,
    header: Option<(&str, &str)>,
) -> Result<Value> {
    let mut request = http.post(url)?.json(payload);
    if let Some((name, value)) = header {
        request = request.header(name, value)
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        bail!("Notification returned HTTP {}", response.status().as_u16())
    }
    let bytes = response.bytes().await?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
fn sign(key: &str, message: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts every key");
    mac.update(message.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}
async fn webhook(
    http: &brz_http::Client,
    value: &Value,
    name: &str,
    _status: &str,
    message: &str,
) -> Result<()> {
    let endpoint = value["url"].as_str().context("Webhook URL missing")?;
    let signing = secret(value, "secret")?;
    let mut url = endpoint.to_owned();
    let mut header = None;
    let payload = match value["type"].as_str().unwrap_or("custom") {
        "dingtalk" => {
            if !signing.is_empty() {
                let timestamp = Utc::now().timestamp_millis().to_string();
                let signature = sign(&signing, &format!("{timestamp}\n{signing}"));
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("timestamp", &timestamp)
                    .append_pair("sign", &signature)
                    .finish();
                url = format!(
                    "{endpoint}{}{query}",
                    if endpoint.contains('?') { "&" } else { "?" }
                );
            }
            let mut preview = message.chars().take(20).collect::<String>();
            if message.chars().count() > 20 {
                preview.push_str("...")
            }
            json!({"msgtype":"markdown","markdown":{"title":preview.replace('\n'," ").trim(),"text":format!("### {name}\n\n{message}")}})
        }
        "feishu" => {
            let mut payload = json!({"msg_type":"post","content":{"post":{"zh_cn":{"title":name,"content":[[{"tag":"text","text":message}]]}}}});
            if !signing.is_empty() {
                let time = Utc::now().timestamp().to_string();
                payload["timestamp"] = json!(time);
                payload["sign"] = json!(sign(&format!("{time}\n{signing}"), ""));
            }
            payload
        }
        _ => {
            if !signing.is_empty() {
                header = Some(("X-Webhook-secret", signing.as_str()))
            }
            json!({"content":message,"subscription_name":name,"timestamp":Utc::now().timestamp()})
        }
    };
    let result = post(http, &url, &payload, header).await?;
    if value["type"] == "dingtalk" && result["errcode"] != 0 {
        bail!("DingTalk webhook rejected notification")
    }
    if value["type"] == "feishu" && result["code"] != 0 && result["StatusCode"] != 0 {
        bail!("Feishu webhook rejected notification")
    }
    Ok(())
}
async fn telegram(
    http: &brz_http::Client,
    config: &Value,
    binding: &Value,
    name: &str,
    message: &str,
) -> Result<()> {
    let token = secret(config, "bot_token")?;
    if token.is_empty() {
        return Ok(());
    }
    let chat = binding["sender_id"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .context("Telegram binding has no chat id")?;
    let result = post(
        http,
        &format!("https://api.telegram.org/bot{token}/sendMessage"),
        &json!({"chat_id":chat,"text":format!("*{name}*\n\n{message}"),"parse_mode":"Markdown"}),
        None,
    )
    .await?;
    if result["ok"] != true {
        bail!("Telegram rejected notification")
    }
    Ok(())
}
async fn dingtalk(
    app: &AppState,
    http: &brz_http::Client,
    config: &Value,
    binding: &Value,
    options: &Value,
    title: &str,
    message: &str,
) -> Result<()> {
    let client_id = config["client_id"].as_str().unwrap_or("");
    let client_secret = secret(config, "client_secret")?;
    if client_id.is_empty() || client_secret.is_empty() {
        return Ok(());
    }
    let result = post(
        http,
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        &json!({"appKey":client_id,"appSecret":client_secret}),
        None,
    )
    .await?;
    let access = result["accessToken"]
        .as_str()
        .context("DingTalk access token missing")?;
    let user = binding["sender_staff_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| binding["sender_id"].as_str())
        .unwrap_or("");
    let private = options["bind_private"].as_bool().unwrap_or(true);
    let template = config["card_template_id"]
        .as_str()
        .filter(|s| !s.is_empty());
    if let Some(template) = template {
        if private && !user.is_empty() {
            card(
                http,
                access,
                client_id,
                template,
                &format!("dtv1.card//IM_ROBOT.{user}"),
                title,
                message,
                &[],
            )
            .await?;
        }
        if options["bind_group"] == true
            && let Some(group) = options["group_conversation_id"]
                .as_str()
                .filter(|s| !s.is_empty())
        {
            let mentions = mentions(
                app,
                options["group_mention_user_ids"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            )
            .await;
            card(
                http,
                access,
                client_id,
                template,
                &format!("dtv1.card//IM_GROUP.{group}"),
                title,
                message,
                &mentions,
            )
            .await?;
        }
    } else if private && !user.is_empty() {
        let mut preview = message.chars().take(20).collect::<String>();
        if message.chars().count() > 20 {
            preview.push_str("...")
        }
        post(http,"https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",&json!({"robotCode":client_id,"userIds":[user],"msgKey":"sampleMarkdown","msgParam":serde_json::to_string(&json!({"title":preview.replace('\n'," ").trim(),"text":format!("### {title}\n\n{message}")}))?}),Some(("x-acs-dingtalk-access-token",access))).await?;
    }
    Ok(())
}
async fn mentions(app: &AppState, values: &[Value]) -> Vec<(String, String)> {
    let mut result = Vec::new();
    for value in values.iter().filter_map(Value::as_str) {
        let (id, provided) = value.split_once(':').unwrap_or((value, ""));
        let mut name = provided.to_owned();
        if id.chars().all(|c| c.is_ascii_digit())
            && let Ok(Some(user)) = app
                .mysql
                .fetch_optional::<_, _, brz_mysql::MysqlRow>(
                    "SELECT email FROM users WHERE user_name=? AND is_active=1 LIMIT 1",
                    (id,),
                )
                .await
            && let Ok(Some(email)) = user.get::<String>("email")
            && let Some(url) =
                crate::config::env_or_dotenv("DINGTALK_USER_INFO_URL").filter(|v| !v.is_empty())
            && let Ok(http) = brz_http::Client::builder()
                .read_timeout(std::time::Duration::from_secs(5))
                .build()
            && let Ok(users) = post(&http, &url, &json!({"emails":[email]}), None).await
            && let Some(resolved) = users[0]["NAME"].as_str().filter(|v| !v.is_empty())
        {
            name = resolved.into();
        }
        if name.is_empty() {
            name = id.into()
        }
        result.push((id.into(), name));
    }
    result
}
#[allow(clippy::too_many_arguments)]
async fn card(
    http: &brz_http::Client,
    access: &str,
    robot: &str,
    template: &str,
    space: &str,
    title: &str,
    message: &str,
    mentions: &[(String, String)],
) -> Result<()> {
    let track = super::super::project::notifications::uuid();
    let content = if mentions.is_empty() {
        message.to_owned()
    } else {
        format!(
            "{}\n\n{message}",
            mentions
                .iter()
                .map(|(_, name)| format!("@{name}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let mut payload = json!({"outTrackId":track,"cardTemplateId":template,"openSpaceId":space,"cardData":{"cardParamMap":{"title":title,"content":content,"sys_full_json_obj":"{\"config\":{\"autoLayout\":true}}"}}});
    if space.contains("IM_GROUP") {
        payload["imGroupOpenSpaceModel"] =
            json!({"supportForward":true,"lastMessageI18n":{"ZH_CN":"您收到一条订阅通知"}});
        let at = mentions
            .iter()
            .map(|(id, name)| (id.clone(), json!(name)))
            .collect::<serde_json::Map<String, Value>>();
        payload["imGroupOpenDeliverModel"] =
            json!({"spaceType":"IM_GROUP","robotCode":robot,"atUserIds":at});
    } else {
        payload["imRobotOpenSpaceModel"] =
            json!({"supportForward":true,"lastMessageI18n":{"ZH_CN":"您收到一条订阅通知"}});
        payload["imRobotOpenDeliverModel"] = json!({"spaceType":"IM_ROBOT"});
    }
    let header = Some(("x-acs-dingtalk-access-token", access));
    let result = post(
        http,
        "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
        &payload,
        header,
    )
    .await?;
    if result.get("code").is_some_and(|v| v != "0") {
        bail!("DingTalk card rejected")
    }
    let final_frame = json!({"outTrackId":track,"cardTemplateId":template,"openSpaceId":space,"key":"content","content":content,"isFull":true,"guid":super::super::project::notifications::uuid(),"isFinalize":true});
    let response = http
        .put("https://api.dingtalk.com/v1.0/card/streaming")?
        .header("x-acs-dingtalk-access-token", access)
        .json(&final_frame)
        .send()
        .await;
    if let Err(error) = response {
        tracing::warn!(%error,"DingTalk final card frame failed")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_use_provider_specific_key_and_message_order() {
        assert_ne!(sign("secret", "1000\nsecret"), sign("1000\nsecret", ""));
        assert_eq!(format_message("日报", "COMPLETED", "### 输出"), "### 输出");
        assert!(format_message("日报", "FAILED", "bad").contains("执行失败"));
    }
}
