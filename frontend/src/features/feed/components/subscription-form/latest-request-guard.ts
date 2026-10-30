// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface LatestRequestGuard {
  /** Claim a new request slot and return its id. */
  begin: () => number
  /** Whether the response of `requestId` still belongs to the newest request. */
  isLatest: (requestId: number) => boolean
  /** Invalidate every request issued so far. */
  invalidate: () => void
}

/**
 * Keep async form loaders from applying stale responses.
 *
 * Opening another subscription or resetting the form invalidates the requests
 * that are still in flight, so a slow response can never restore an old
 * selection or overwrite a freshly opened create form.
 */
export function createLatestRequestGuard(): LatestRequestGuard {
  let current = 0

  return {
    begin: () => {
      current += 1
      return current
    },
    isLatest: (requestId: number) => requestId === current,
    invalidate: () => {
      current += 1
    },
  }
}
