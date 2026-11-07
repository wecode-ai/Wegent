// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Membership and effective-role policy without application or resource-handler dependencies.

#![forbid(unsafe_code)]

pub mod namespace_projection;
pub mod permissions;
pub mod roles;

pub mod public_models;

pub mod group_membership;
pub mod group_queries;

pub mod task_membership;
