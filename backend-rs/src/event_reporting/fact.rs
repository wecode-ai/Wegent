// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt;

use super::contract::{EventStatus, Field};

const MAX_DATA_FIELDS: usize = 48;
const MAX_FACT_KEY_PARTS: usize = 64;
const MAX_ID_LIST_ITEMS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedString<const N: usize>(String);

impl<const N: usize> BoundedString<N> {
    pub fn new(value: impl Into<String>) -> Result<Self, FactBuildError> {
        let value = value.into();
        if value.chars().count() > N {
            return Err(FactBuildError::StringTooLarge);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WireInteger {
    Signed(i64),
    Unsigned(u64),
}

impl From<i64> for WireInteger {
    fn from(value: i64) -> Self {
        Self::Signed(value)
    }
}

impl From<u64> for WireInteger {
    fn from(value: u64) -> Self {
        Self::Unsigned(value)
    }
}

impl From<i32> for WireInteger {
    fn from(value: i32) -> Self {
        Self::Signed(i64::from(value))
    }
}

impl From<usize> for WireInteger {
    fn from(value: usize) -> Self {
        Self::Unsigned(value as u64)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Scalar {
    Null,
    Bool(bool),
    Integer(WireInteger),
    FiniteF64(f64),
    Text(BoundedString<256>),
    IdList(Vec<Scalar>),
}

impl Scalar {
    pub fn text(value: impl Into<String>) -> Result<Self, FactBuildError> {
        Ok(Self::Text(BoundedString::new(value)?))
    }

    pub fn finite(value: f64) -> Result<Self, FactBuildError> {
        if value.is_finite() {
            Ok(Self::FiniteF64(value))
        } else {
            Err(FactBuildError::NonFiniteFloat)
        }
    }

    pub fn id_list(values: Vec<Scalar>) -> Result<Self, FactBuildError> {
        if values.len() > MAX_ID_LIST_ITEMS
            || values.iter().any(|value| matches!(value, Self::IdList(_)))
        {
            return Err(FactBuildError::InvalidIdList);
        }
        Ok(Self::IdList(values))
    }
}

impl From<i64> for Scalar {
    fn from(value: i64) -> Self {
        Self::Integer(value.into())
    }
}

impl From<u64> for Scalar {
    fn from(value: u64) -> Self {
        Self::Integer(value.into())
    }
}

impl From<bool> for Scalar {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum EntityId {
    Integer(WireInteger),
    Text(BoundedString<256>),
}

impl From<i64> for EntityId {
    fn from(value: i64) -> Self {
        Self::Integer(value.into())
    }
}

#[derive(Clone, Debug)]
pub struct FactDraft {
    pub status: EventStatus,
    pub kb_id: Option<EntityId>,
    pub document_id: Option<EntityId>,
    pub error_code: Option<BoundedString<256>>,
    pub duration_ms: Option<WireInteger>,
    pub fact_key_parts: Vec<Scalar>,
    pub data: Vec<(Field, Scalar)>,
}

impl FactDraft {
    #[must_use]
    pub fn success() -> Self {
        Self::new(EventStatus::Success)
    }

    #[must_use]
    pub fn new(status: EventStatus) -> Self {
        Self {
            status,
            kb_id: None,
            document_id: None,
            error_code: None,
            duration_ms: None,
            fact_key_parts: Vec::new(),
            data: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_kb_id(mut self, value: impl Into<EntityId>) -> Self {
        self.kb_id = Some(value.into());
        self
    }

    #[must_use]
    pub fn with_document_id(mut self, value: impl Into<EntityId>) -> Self {
        self.document_id = Some(value.into());
        self
    }

    pub fn with_error_code(mut self, value: impl Into<String>) -> Result<Self, FactBuildError> {
        let value = BoundedString::new(value)?;
        if value.as_str().trim().is_empty() {
            return Err(FactBuildError::EmptyErrorCode);
        }
        self.error_code = Some(value);
        Ok(self)
    }

    #[must_use]
    pub fn with_duration_ms(mut self, value: impl Into<WireInteger>) -> Self {
        self.duration_ms = Some(value.into());
        self
    }

    pub fn with_fact_key_part(mut self, value: Scalar) -> Result<Self, FactBuildError> {
        if self.fact_key_parts.len() >= MAX_FACT_KEY_PARTS || matches!(value, Scalar::IdList(_)) {
            return Err(FactBuildError::TooManyFactKeyParts);
        }
        self.fact_key_parts.push(value);
        Ok(self)
    }

    pub fn with_field(mut self, field: Field, value: Scalar) -> Result<Self, FactBuildError> {
        if self.data.len() >= MAX_DATA_FIELDS {
            return Err(FactBuildError::TooManyDataFields);
        }
        if matches!(value, Scalar::IdList(_)) != field.accepts_list() {
            return Err(FactBuildError::InvalidIdList);
        }
        self.data.push((field, value));
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FactBuildError {
    StringTooLarge,
    NonFiniteFloat,
    InvalidIdList,
    TooManyDataFields,
    TooManyFactKeyParts,
    EmptyErrorCode,
}

impl fmt::Display for FactBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StringTooLarge => "event_string_too_large",
            Self::NonFiniteFloat => "unsupported_event_value",
            Self::InvalidIdList => "invalid_id_list",
            Self::TooManyDataFields => "invalid_event_contract",
            Self::TooManyFactKeyParts => "too_many_fact_parts",
            Self::EmptyErrorCode => "empty_error_code",
        })
    }
}

impl std::error::Error for FactBuildError {}
