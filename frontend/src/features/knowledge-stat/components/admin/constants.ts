// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const DOMAIN_LIST = [
  'kb_lifecycle',
  'doc_management',
  'retrieval',
  'user_behavior',
  'collaboration',
  'deep_analysis',
  'sys_ops',
  'prometheus',
] as const

export type DomainName = (typeof DOMAIN_LIST)[number]
