// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SubscriptionBindingUpdatePayload } from '@/types/subscription'

export function shouldShowPrivateBindingSuccessToast(
  payload: SubscriptionBindingUpdatePayload,
  wasWaiting: boolean
): boolean {
  return Boolean(wasWaiting && payload.completed && payload.private_bound && !payload.group_bound)
}
