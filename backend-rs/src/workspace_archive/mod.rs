// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Internal workspace-archive endpoints.
//!
//! Mirrors `app/api/endpoints/internal/workspace_archives.py` and the
//! `app/services/workspace_archive` package. `POST
//! /api/internal/workspace-archives/{task_id}/restore-sandbox` restores a
//! sandbox's workspace files from the task's latest stored archive.
mod handler;
pub(crate) mod s3_presign;
pub(crate) mod save;
mod service;
mod storage;
