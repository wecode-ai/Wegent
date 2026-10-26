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
 * The single-subscription endpoint always reflects the stored record, so fall
 * back to the list item only when that request fails.
 */
export async function loadEditableSubscription(subscription: Subscription): Promise<Subscription> {
  try {
    const latest = await subscriptionApis.getSubscription(subscription.id)
    return latest ?? subscription
  } catch (error) {
    console.error('Failed to load subscription detail:', error)
    return subscription
  }
}
