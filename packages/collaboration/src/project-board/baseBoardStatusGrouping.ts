// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const baseBoardStatusGroupingFlag = 'collab.baseBoardStatusGrouping.v1'

/** Reload after changing the flag; keep legacy preferences intact for rollback. */
export function isBaseBoardStatusGroupingEnabled(): boolean {
  return (
    typeof localStorage === 'undefined' ||
    localStorage.getItem(baseBoardStatusGroupingFlag) !== 'false'
  )
}
