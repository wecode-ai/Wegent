// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Skill endpoints use the shared CRD projection rather than maintaining a
//! second copy of the same `spec` and reference schema.
pub(super) use crate::crd::{CrdDocument as SkillInput, ResourceReference as TeamReference};
