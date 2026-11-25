import type { TFunction } from 'i18next'
import { issueStatusHistoryLabels } from '@wegent/collaboration'

export function statusHistoryLabels(t: TFunction) {
  return issueStatusHistoryLabels((key, fallback) => t(key, fallback ?? key))
}
