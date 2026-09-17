// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional application-specific fields in public user responses.
use crate::auth::UserRow;
use serde::{Serialize, Serializer};

pub use crate::users_me::UserView;

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
