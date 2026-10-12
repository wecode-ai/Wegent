// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/marketplace-resources` service.
//!
//! Port of `app.api.endpoints.admin.marketplace.list_marketplace_resources`
//! plus the `_to_response` / `_resource_metadata` / `_marketplace_config` /
//! `_marketplace_recommendation_score` helpers it delegates to. The two scans
//! run in source order (system rows, then published rows), the merged list is
//! ordered by `(recommendation_score, updated_at, id)` descending, and the
//! page is sliced from the fully materialized list.

use brz_mysql::Mysql;
use chrono::NaiveDateTime;

use crate::http_compat::FastApiError;

use super::models::{
    AdminMarketplaceResource, AdminMarketplaceResourceList, ConversationInput, ExampleConversation,
    JsonScalar, KindPayload, ListingParams,
};
use super::repository::{
    PayloadRow, PublishedRow, SystemRow, fetch_published_rows, fetch_system_rows,
};

/// One row projected through `_to_response`.
pub struct Source<'a> {
    pub id: i64,
    pub user_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub payload: &'a KindPayload,
    pub publisher_user_name: Option<&'a str>,
    /// `marketplace_resources.recommendation_score`, present only for
    /// publisher rows.
    pub published_score: Option<i64>,
    pub updated_at: NaiveDateTime,
}

/// `list_marketplace_resources`.
pub async fn list<M: Mysql>(
    mysql: &M,
    params: &ListingParams,
) -> Result<AdminMarketplaceResourceList, FastApiError> {
    let system_rows = fetch_system_rows(mysql, params.kind)
        .await
        .map_err(internal_error)?;
    let published_rows = fetch_published_rows(mysql, params.kind, params.resource_type)
        .await
        .map_err(internal_error)?;

    let mut entries: Vec<(AdminMarketplaceResource, NaiveDateTime)> =
        Vec::with_capacity(system_rows.len() + published_rows.len());
    let empty = KindPayload::default();
    for row in &system_rows {
        let source = system_source(row, row.payload().unwrap_or(&empty));
        entries.push((source.to_response()?, source.updated_at));
    }
    for row in &published_rows {
        let source = published_source(row, row.payload().unwrap_or(&empty));
        entries.push((source.to_response()?, source.updated_at));
    }

    // `.sort(key=lambda row: (score, updated_at, id), reverse=True)`.
    entries.sort_by(|left, right| {
        right
            .0
            .recommendation_score
            .cmp(&left.0.recommendation_score)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.0.id.cmp(&left.0.id))
    });

    let total = entries.len();
    let start = (params.page - 1).saturating_mul(params.limit);
    let items = if start < 0 {
        Vec::new()
    } else {
        entries
            .into_iter()
            .map(|(item, _)| item)
            .skip(start as usize)
            .take(params.limit as usize)
            .collect()
    };
    Ok(AdminMarketplaceResourceList {
        items,
        total,
        page: params.page,
        limit: params.limit,
    })
}

/// The system-row source (`_to_response(resource, None, None)`).
fn system_source<'a>(row: &'a SystemRow, payload: &'a KindPayload) -> Source<'a> {
    Source {
        id: row.kinds_id,
        user_id: row.kinds_user_id,
        kind: &row.kinds_kind,
        name: &row.kinds_name,
        payload,
        publisher_user_name: None,
        published_score: None,
        updated_at: row.kinds_updated_at,
    }
}

/// The publisher-row source (`_to_response(resource, user_name, score)`).
fn published_source<'a>(row: &'a PublishedRow, payload: &'a KindPayload) -> Source<'a> {
    Source {
        id: row.kinds_id,
        user_id: row.kinds_user_id,
        kind: &row.kinds_kind,
        name: &row.kinds_name,
        payload,
        publisher_user_name: row.users_user_name.as_deref(),
        published_score: Some(row.marketplace_resources_recommendation_score),
        updated_at: row.kinds_updated_at,
    }
}

impl Source<'_> {
    /// `_to_response`.
    fn to_response(&self) -> Result<AdminMarketplaceResource, FastApiError> {
        let payload = self.payload;
        let is_system = self.user_id == 0;

        let display = if is_system {
            if self.kind == "Skill" {
                payload
                    .spec()
                    .and_then(|spec| spec.display_name.value.as_ref())
            } else {
                payload
                    .metadata()
                    .and_then(|metadata| metadata.display_name.value.as_ref())
            }
        } else {
            payload
                .capability()
                .and_then(|capability| capability.display_name.value.as_ref())
        };
        let description = if is_system || self.kind == "Skill" {
            payload
                .spec()
                .and_then(|spec| spec.description.value.as_ref())
        } else {
            payload
                .capability()
                .and_then(|capability| capability.description.value.as_ref())
        };

        let recommendation_score = if is_system {
            marketplace_recommendation_score(payload)
        } else {
            self.published_score.unwrap_or(0)
        };

        Ok(AdminMarketplaceResource {
            id: self.id,
            resource_type: if self.kind == "Team" {
                "agent"
            } else {
                "skill"
            },
            name: self.name.to_owned(),
            display_name: display_name(display, self.name),
            description: description.map(JsonScalar::text),
            publisher_user_name: self.publisher_user_name.map(ToOwned::to_owned),
            is_system,
            recommendation_score,
            example_conversations: example_conversations(payload, self.kind)?,
        })
    }
}

/// `str(display_name or resource.name)`.
fn display_name(display: Option<&JsonScalar>, name: &str) -> String {
    match display {
        Some(value) if !value.is_falsy() => value.text(),
        _ => name.to_owned(),
    }
}

/// `_marketplace_recommendation_score`.
fn marketplace_recommendation_score(payload: &KindPayload) -> i64 {
    payload
        .marketplace()
        .and_then(|marketplace| marketplace.recommendation_score.value.as_ref())
        .and_then(JsonScalar::integer)
        .map_or(0, |score| score.clamp(0, 100))
}

/// `marketplace.get("exampleConversations", [])` projected through
/// `MarketplaceExampleConversation`. Only Agents (Team) keep examples; other
/// kinds answer `[]`. A present value of the wrong shape fails pydantic
/// validation in the source, so the target answers the application's
/// unhandled-error body.
fn example_conversations(
    payload: &KindPayload,
    kind: &str,
) -> Result<Vec<ExampleConversation>, FastApiError> {
    if kind != "Team" {
        return Ok(Vec::new());
    }
    let Some(marketplace) = payload.marketplace() else {
        return Ok(Vec::new());
    };
    let stored = &marketplace.example_conversations;
    if !stored.present {
        return Ok(Vec::new());
    }
    let Some(entries) = stored.value.as_ref() else {
        return Err(unhandled());
    };
    let mut conversations = Vec::with_capacity(entries.len());
    for entry in entries {
        conversations.push(conversation(entry).ok_or_else(unhandled)?);
    }
    Ok(conversations)
}

/// One stored conversation entry. `None` when the source's pydantic model
/// (`title`: 1..=100 characters after strip; `url`: HTTP(S) with a host, at
/// most 2048 characters) rejects it.
fn conversation(entry: &ConversationInput) -> Option<ExampleConversation> {
    let title = entry.title.value.as_ref()?.text_value()?;
    let url = entry.url.value.as_ref()?.text_value()?;

    let title_length = title.chars().count();
    if !(1..=100).contains(&title_length) {
        return None;
    }
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    if url.chars().count() > 2048 {
        return None;
    }
    let url = url.trim();
    if !is_http_url(url) {
        return None;
    }
    Some(ExampleConversation {
        title: title.to_owned(),
        url: url.to_owned(),
    })
}

/// `urlparse(url).scheme in {http, https} and urlparse(url).netloc`.
fn is_http_url(url: &str) -> bool {
    let Some((scheme, remainder)) = url.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // `urlparse` keeps the authority up to the first path, query or fragment
    // separator; an empty authority is rejected.
    !remainder
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .is_empty()
}

/// The source's `python_exception_handler` 500 body.
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "admin marketplace resources dependency failed");
    unhandled()
}

/// The application's `python_exception_handler` body for an unmapped failure.
fn unhandled() -> FastApiError {
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::JsonField;
    use chrono::NaiveDate;

    use super::super::models::{Capability, KindMetadata, KindSpec, MarketplaceConfig};

    fn text(value: &str) -> JsonField<JsonScalar> {
        present(JsonScalar::Text(value.to_owned()))
    }

    fn int(value: i64) -> JsonField<JsonScalar> {
        present(JsonScalar::Int(value))
    }

    fn present<T>(value: T) -> JsonField<T> {
        JsonField {
            present: true,
            value: Some(value),
        }
    }

    fn naive() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn payload(spec: KindSpec) -> KindPayload {
        KindPayload {
            metadata: present(KindMetadata::default()),
            spec: present(spec),
        }
    }

    #[test]
    fn system_agent_reads_metadata_display_name_and_marketplace_examples() {
        let spec = KindSpec {
            description: text("接入Seedance2.5模型"),
            capability: present(Capability {
                marketplace: present(MarketplaceConfig {
                    recommendation_score: int(90),
                    example_conversations: present(vec![ConversationInput {
                        title: text("添加参考图生成视频"),
                        url: text("https://wegent.example/shared/task?token=x"),
                    }]),
                }),
                ..Capability::default()
            }),
            ..KindSpec::default()
        };
        let payload = KindPayload {
            metadata: present(KindMetadata {
                display_name: text("生成视频"),
            }),
            spec: present(spec),
        };
        let source = Source {
            id: 269955,
            user_id: 0,
            kind: "Team",
            name: "生成视频",
            payload: &payload,
            publisher_user_name: None,
            published_score: None,
            updated_at: naive(),
        };
        let resource = source.to_response().unwrap();
        assert_eq!(resource.resource_type, "agent");
        assert!(resource.is_system);
        assert_eq!(resource.recommendation_score, 90);
        assert_eq!(resource.display_name, "生成视频");
        assert_eq!(resource.description.as_deref(), Some("接入Seedance2.5模型"));
        assert_eq!(resource.publisher_user_name, None);
        assert_eq!(
            resource.example_conversations[0].title,
            "添加参考图生成视频"
        );
    }

    #[test]
    fn publisher_rows_use_capability_and_the_stored_score() {
        let payload = payload(KindSpec {
            capability: present(Capability {
                display_name: text("Published"),
                description: text("desc"),
                ..Capability::default()
            }),
            ..KindSpec::default()
        });
        let source = Source {
            id: 7,
            user_id: 157,
            kind: "Team",
            name: "team-name",
            payload: &payload,
            publisher_user_name: Some("example-user"),
            published_score: Some(12),
            updated_at: naive(),
        };
        let resource = source.to_response().unwrap();
        assert_eq!(resource.display_name, "Published");
        assert_eq!(resource.description.as_deref(), Some("desc"));
        assert_eq!(
            resource.publisher_user_name.as_deref(),
            Some("example-user")
        );
        assert!(!resource.is_system);
        assert_eq!(resource.recommendation_score, 12);
    }

    #[test]
    fn skills_drop_example_conversations_and_clamp_the_score() {
        let payload = payload(KindSpec {
            description: text("s"),
            capability: present(Capability {
                marketplace: present(MarketplaceConfig {
                    recommendation_score: int(500),
                    example_conversations: present(vec![ConversationInput {
                        title: text("x"),
                        url: text("https://a.example"),
                    }]),
                }),
                ..Capability::default()
            }),
            ..KindSpec::default()
        });
        let source = Source {
            id: 3,
            user_id: 0,
            kind: "Skill",
            name: "skill",
            payload: &payload,
            publisher_user_name: None,
            published_score: None,
            updated_at: naive(),
        };
        let resource = source.to_response().unwrap();
        assert_eq!(resource.resource_type, "skill");
        assert_eq!(resource.recommendation_score, 100);
        assert!(resource.example_conversations.is_empty());
    }

    #[test]
    fn missing_display_name_falls_back_to_the_resource_name() {
        let payload = payload(KindSpec::default());
        let source = Source {
            id: 4,
            user_id: 0,
            kind: "Team",
            name: "fallback",
            payload: &payload,
            publisher_user_name: None,
            published_score: None,
            updated_at: naive(),
        };
        let resource = source.to_response().unwrap();
        assert_eq!(resource.display_name, "fallback");
        assert_eq!(resource.description, None);
        assert!(resource.example_conversations.is_empty());
    }

    #[test]
    fn invalid_example_conversations_surface_as_an_unhandled_error() {
        let payload = payload(KindSpec {
            capability: present(Capability {
                marketplace: present(MarketplaceConfig {
                    example_conversations: JsonField {
                        present: true,
                        value: None,
                    },
                    ..MarketplaceConfig::default()
                }),
                ..Capability::default()
            }),
            ..KindSpec::default()
        });
        let source = Source {
            id: 5,
            user_id: 0,
            kind: "Team",
            name: "bad",
            payload: &payload,
            publisher_user_name: None,
            published_score: None,
            updated_at: naive(),
        };
        let error = source.to_response().unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
