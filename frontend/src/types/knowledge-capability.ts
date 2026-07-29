// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** One-shot request that opens a new knowledge-task draft without sending it. */
export interface KnowledgeCapabilityDraftRequest {
  requestId: string
  message: string
}
