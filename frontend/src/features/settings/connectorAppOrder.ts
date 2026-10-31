// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UserConnectorApp } from '@/apis/admin'

/** Built-in DingTalk apps keep a stable, prominent position. */
export const DINGTALK_CONNECTOR_APP_ORDER = [
  'dingtalk_docs',
  'dingtalk_sheet',
  'dingtalk_aitable',
  'dingtalk_wiki',
] as const

const DINGTALK_RANK = new Map<string, number>(
  DINGTALK_CONNECTOR_APP_ORDER.map((slug, index) => [slug, index])
)

/**
 * Put the four built-in DingTalk apps first, then authorized apps, then the
 * remaining apps. The sort is stable, so untouched apps keep the server order.
 */
export function sortConnectorAppsByConnection(
  apps: readonly UserConnectorApp[]
): UserConnectorApp[] {
  const rank = (app: UserConnectorApp) => {
    const dingtalkRank = DINGTALK_RANK.get(app.slug)
    if (dingtalkRank !== undefined) return dingtalkRank
    return DINGTALK_CONNECTOR_APP_ORDER.length + (app.connection.status === 'connected' ? 0 : 1)
  }
  return [...apps].sort((left, right) => rank(left) - rank(right))
}
