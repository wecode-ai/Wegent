// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional application-specific fields and resolution hooks for the public
//! user views.
use crate::auth::UserRow;
use async_trait::async_trait;
use serde::{Serialize, Serializer};

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
    fn current_user_ext(&self, _user: &UserRow) -> UserViewExt {
        UserViewExt::empty()
    }

    fn cached_user_ext(&self, _preferences: Option<&str>) -> UserViewExt {
        UserViewExt::empty()
    }
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
