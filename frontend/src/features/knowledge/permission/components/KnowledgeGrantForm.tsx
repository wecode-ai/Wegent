// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  KnowledgeBaseAuthSection,
  type AuthEntry,
} from '../../document/components/KnowledgeBaseAuthSection'
import { useKnowledgeGrants } from '../hooks/useKnowledgeGrants'

export function KnowledgeGrantForm({
  kbId,
  kbNamespace,
  boundNamespaceIds,
  onChanged,
  onAccessDenied,
  onCancel,
}: {
  kbId: number
  kbNamespace?: string
  boundNamespaceIds?: string[]
  onChanged: () => void
  onAccessDenied?: () => void
  onCancel?: () => void
}) {
  const { t } = useTranslation('knowledge')
  const [entries, setEntries] = useState<AuthEntry[]>([])
  const [finished, setFinished] = useState(false)
  const { grant, loading, failures, error, uncertain } = useKnowledgeGrants({
    kbId,
    onChanged,
    onAccessDenied,
  })
  const submit = async () => {
    const remaining = await grant(entries)
    if (remaining === null) return
    setEntries(remaining)
    setFinished(remaining.length === 0)
  }
  return (
    <section className="flex min-h-0 flex-col gap-3" data-testid="created-knowledge-authorization">
      <div
        className="min-h-0 overflow-y-auto overscroll-contain break-words"
        data-testid="knowledge-grant-scroll-area"
      >
        <fieldset disabled={loading || uncertain} className="min-w-0">
          <KnowledgeBaseAuthSection
            defaultOpen
            value={entries}
            excludedNamespaceId={kbNamespace}
            boundNamespaceIds={boundNamespaceIds}
            onChange={value => {
              setFinished(false)
              setEntries(value)
            }}
          />
        </fieldset>
        {finished && (
          <p role="status" className="mt-3" data-testid="knowledge-authorization-complete">
            {t('document.creation.authorized')}
          </p>
        )}
        {(error || failures.length > 0) && (
          <div role="alert" className="mt-3 text-sm text-error">
            <p>
              {t(error ? 'document.creation.' + error : 'document.creation.authorizationFailed')}
            </p>
            <ul>
              {failures.map(({ entry, error: reason }) => (
                <li key={JSON.stringify([entry.entityType, entry.entityId])}>
                  {entry.label}:{' '}
                  {['unconfirmed', 'roleConflict', 'notSubmitted'].includes(reason)
                    ? t('document.creation.' + reason)
                    : reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        {onCancel && (
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            data-testid="cancel-created-permissions"
            onClick={onCancel}
          >
            {t('common:actions.cancel')}
          </Button>
        )}
        <Button
          variant="primary"
          className="min-h-11 min-w-11"
          data-testid="submit-created-permissions"
          disabled={loading || entries.length === 0}
          onClick={() => void submit()}
        >
          {t(
            loading
              ? 'document.creation.authorizing'
              : uncertain
                ? 'document.creation.verifyAndRetry'
                : failures.length
                  ? 'document.creation.retryFailed'
                  : 'document.creation.authorize'
          )}
        </Button>
      </div>
    </section>
  )
}
