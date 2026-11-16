// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { subscriptionApis } from '@/apis/subscription'
import type { Subscription } from '@/types/subscription'

/**
 * Load the authoritative subscription record before editing it.
 *
 * List responses are refreshed asynchronously after a save and can lag behind
 * the update, which used to reopen the editor with an empty prompt template.
 * The single-subscription endpoint reflects the stored record. Never fall back
 * to a potentially stale list item for an editable form.
 */
export async function loadEditableSubscription(subscription: Subscription): Promise<Subscription> {
  const latest = await subscriptionApis.getSubscription(subscription.id)
  if (!latest) {
    throw new Error('Subscription detail is unavailable')
  }
  return latest
}
