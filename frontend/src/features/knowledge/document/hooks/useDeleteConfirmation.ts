// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react'
import { isContinuableDeletionError } from '@/apis/knowledge-deletion'
import client, { ApiError } from '@/apis/client'
import { useTranslation } from '@/hooks/useTranslation'

export function useDeleteConfirmation(
  open: boolean,
  targetId: number | undefined,
  onConfirm: (continueOnExternalFailure?: boolean) => Promise<void>
) {
  const { t } = useTranslation('knowledge')
  const scope = client.getCacheScope()
  const [error, setError] = useState<string | null>(null)
  const [canContinue, setCanContinue] = useState(false)
  const version = useRef(0)
  const reset = () => {
    version.current += 1
    setError(null)
    setCanContinue(false)
  }

  useEffect(() => {
    version.current += 1
    setError(null)
    setCanContinue(false)
    return () => {
      version.current += 1
    }
  }, [open, targetId, scope])

  const confirm = async () => {
    const continuing = canContinue
    reset()
    if (client.getCacheScope() !== scope) return
    const requestVersion = version.current
    try {
      await onConfirm(continuing)
    } catch (caughtError) {
      if (requestVersion !== version.current || client.getCacheScope() !== scope) return
      const eligible = isContinuableDeletionError(caughtError)
      setCanContinue(eligible)
      setError(
        eligible
          ? t('knowledge:document.deletion.externalWarning')
          : caughtError instanceof ApiError &&
              caughtError.errorCode === 'cleanup_service_authentication_failed'
            ? t('knowledge:document.deletion.serviceAuthFailed')
            : caughtError instanceof Error
              ? caughtError.message
              : t('knowledge:document.deletion.failed')
      )
    }
  }

  return { error, canContinue, confirm, reset }
}
