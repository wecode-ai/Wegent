// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AssistantMessageProvenance {
  activityType:
    | 'human_assistant_result'
    | 'assistant_request_receipt'
    | 'assistant_request_evidence'
  publisherUserId: string
  confirmed: boolean
}

export function assistantMessageProvenance(
  metadata: Record<string, unknown>,
): AssistantMessageProvenance | null {
  const activityType = metadata.activity_type
  if (
    activityType !== 'human_assistant_result' &&
    activityType !== 'assistant_request_receipt' &&
    activityType !== 'assistant_request_evidence'
  )
    return null
  const value = metadata.provenance
  if (
    !value ||
    typeof value !== 'object' ||
    !('origin' in value) ||
    value.origin !== 'ai_generated' ||
    !('publisher_user_id' in value)
  )
    return null
  const publisher = value.publisher_user_id
  if (typeof publisher !== 'string' && typeof publisher !== 'number')
    return null
  return {
    activityType,
    publisherUserId: String(publisher),
    confirmed:
      'confirmation_status' in value &&
      value.confirmation_status === 'confirmed',
  }
}
