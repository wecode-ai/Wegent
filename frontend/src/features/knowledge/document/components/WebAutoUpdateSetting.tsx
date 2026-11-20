// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { getWebAutoUpdate, setWebAutoUpdate } from '@/apis/knowledge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { useTranslation } from '@/hooks/useTranslation'

export function WebAutoUpdateSetting({ knowledgeBaseId }: { knowledgeBaseId: number }) {
  const { t } = useTranslation('knowledge')
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    setPending(true)
    setFailed(false)
    getWebAutoUpdate(knowledgeBaseId)
      .then(result => {
        if (active) setChecked(result.enabled)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setPending(false)
      })
    return () => {
      active = false
    }
  }, [knowledgeBaseId, reload])

  async function update(enabled: boolean) {
    setPending(true)
    setFailed(false)
    try {
      const result = await setWebAutoUpdate(knowledgeBaseId, enabled)
      setChecked(result.enabled)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <SimpleConfigRow
      label={t('document.webAutoUpdate.label')}
      description={t('document.webAutoUpdate.description')}
    >
      <div className="flex min-h-11 items-center gap-2">
        {failed && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setReload(value => value + 1)}
            data-testid="knowledge-web-auto-update-retry"
          >
            {t('document.webAutoUpdate.retry')}
          </Button>
        )}
        <Switch
          className="relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2"
          aria-label={t('document.webAutoUpdate.label')}
          data-testid="knowledge-web-auto-update"
          checked={checked}
          disabled={pending || failed}
          onCheckedChange={update}
        />
      </div>
    </SimpleConfigRow>
  )
}
