// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional application-specific fields and resolution hooks for the public
//! user views.
use crate::auth::UserRow;
use async_trait::async_trait;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

pub use crate::users_me::{GitInfoEntry, UserView, stored_git_info};

/// Current-user `git_info` resolution for `GET /api/users/me`. The public
/// default renders the stored `users.git_info` column; an application whose
/// deployment keeps placeholder Git credentials there resolves them through
/// its own token service before the response is rendered.
///
/// The list is resolved after the response body is built and replaces the
/// rendered `git_info` value as a whole, so an implementation returns the
/// complete list to render.
#[async_trait]
pub trait UserGitInfoProvider: Send + Sync {
    /// The `git_info` entries to render for `user`; `None` renders `null`.
    async fn resolved_git_info(&self, user: &UserRow) -> Option<Vec<GitInfoEntry>> {
        crate::users_me::stored_git_info(user)
    }
}

/// No application Git token service is registered.
pub struct StoredGitInfo;

#[async_trait]
impl UserGitInfoProvider for StoredGitInfo {}

/// Post-update `git_info` rewrite for `PUT /api/users/me`. The source wraps
/// `UserService.update_current_user` with an application patch that runs after
/// the public update refreshes the row: it re-masks the stored `git_info` and
/// commits it a second time whenever the masked document is not `None`
/// through its registered masking provider.
///
/// The public default returns `None`, so the public update emits no second
/// write. An application whose deployment keeps placeholder Git credentials in
/// `users.git_info` registers its own implementation, whose result the handler
/// persists with the same `UPDATE users SET git_info=…, updated_at=now()`,
/// cache invalidation, `COMMIT`, and refresh as the source.
#[async_trait]
pub trait UserGitInfoMasker: Send + Sync {
    /// The `git_info` document to persist after the update, or `None` to skip
    /// the second write. Called with the refreshed `users.git_info` value; the
    /// source skips only when its mask returns `None` (a Python `None` input).
    async fn masked_git_info(&self, _git_info: &Value) -> Option<Value> {
        None
    }
}

/// No application Git token masking is registered.
pub struct NoGitInfoMasking;

#[async_trait]
impl UserGitInfoMasker for NoGitInfoMasking {}

/// Application-specific typed fields for the user view and its preferences.
pub struct UserViewExt {
    pub(crate) top_level: ErasedFields,
    pub(crate) preferences: ErasedFields,
}

impl UserViewExt {
    pub fn new<Top, Preferences>(top_level: Top, preferences: Preferences) -> Self
    where
        Top: Serialize + Send + Sync + 'static,
        Preferences: Serialize + Send + Sync + 'static,
    {
        Self {
            top_level: ErasedFields::new(top_level),
            preferences: ErasedFields::new(preferences),
        }
    }

    pub fn empty() -> Self {
        Self::new(NoProfileFields {}, NoProfileFields {})
    }

    pub(crate) fn into_parts(self) -> (ErasedFields, ErasedFields) {
        (self.top_level, self.preferences)
    }
}

/// A typed field group with its concrete application type erased for runtime
/// dispatch. Serde still walks the original struct when it is flattened.
pub(crate) struct ErasedFields(Box<dyn erased_serde::Serialize + Send + Sync>);

impl ErasedFields {
    fn new<T>(value: T) -> Self
    where
        T: Serialize + Send + Sync + 'static,
    {
        Self(Box::new(value))
    }
}

impl Serialize for ErasedFields {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        erased_serde::serialize(self.0.as_ref(), serializer)
    }
}

#[derive(Serialize)]
struct NoProfileFields {}

/// Supplies application-specific typed fields for the shared user views.
pub trait UserViewExtension: Send + Sync {
    /// Compose deployment-specific preference updates with the public schema.
    /// Implementations retain declaration order and omit fields managed by
    /// dedicated endpoints. The input contains only the request's preferences.
    fn preference_update_dump(
        &self,
        _input: &Map<String, Value>,
        public_dump: Map<String, Value>,
    ) -> Map<String, Value> {
        public_dump
    }

    fn current_user_ext(&self, _user: &UserRow) -> UserViewExt {
        UserViewExt::empty()
    }

    fn cached_user_ext(&self, _preferences: Option<&str>) -> UserViewExt {
        UserViewExt::empty()
    }

    /// `GET /api/users/me/wegent-runtime`'s encrypted payload fields. The
    /// public endpoint sends an empty `employee_id`, `user.user_name` as
    /// `name`, and `str(user.id)` as `uid`; an application whose deployment
    /// extends the endpoint can override these resolutions with its
    /// own identity fields.
    fn runtime_user_payload_fields(&self, user: &UserRow) -> RuntimeUserPayloadFields {
        RuntimeUserPayloadFields {
            employee_id: String::new(),
            name: user.user_name.clone(),
            uid: user.id.to_string(),
        }
    }
}

/// The application-resolved `GET /api/users/me/wegent-runtime` payload
/// fields: `employee_id`, `name`, and `uid` of the encrypted JSON.
pub struct RuntimeUserPayloadFields {
    /// `payload["employee_id"]` (`""` in the public endpoint).
    pub employee_id: String,
    /// `payload["name"]` (`user.user_name` in the public endpoint).
    pub name: String,
    /// `payload["uid"]` (`str(user.id)` in the public endpoint).
    pub uid: String,
}

/// The public response schema has no external account fields.
pub struct DefaultUserViewExtension;
impl UserViewExtension for DefaultUserViewExtension {}

/// Render the standard public profile with no application-specific fields.
pub fn render_user(user: &UserRow) -> UserView {
    crate::users_me::user_in_db_response(user)
}

/// Compose application-specific typed fields with the public user schema.
pub fn render_user_with_extra(user: &UserRow, extra: UserViewExt) -> UserView {
    crate::users_me::user_in_db_response_with_extra(user, extra)
}
