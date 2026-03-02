// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const SUBSCRIPTION_SCHEME = 'subscription://'

export function parseSubscriptionSchemeUrl(url?: string | null): number | null {
  if (!url) {
    return null
  }

  const trimmedUrl = url.trim()
  if (!trimmedUrl.startsWith(SUBSCRIPTION_SCHEME)) {
    return null
  }

  const match = trimmedUrl.match(/^subscription:\/\/(\d+)/)
  if (!match) {
    return null
  }

  const subscriptionId = Number(match[1])
  if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
    return null
  }

  return subscriptionId
}
