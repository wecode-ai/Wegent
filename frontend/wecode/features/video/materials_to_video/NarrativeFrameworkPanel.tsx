// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Loader2, Pencil, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { narrativeFrameworkApi } from './api'
import type { NarrativeFrameworkResponse } from './types'

interface NarrativeFrameworkPanelProps {
  sessionId: string
  taskUuid: string
  onContinue?: (buttonName?: string) => void
}

export function NarrativeFrameworkPanel({
  sessionId,
  taskUuid,
  onContinue,
}: NarrativeFrameworkPanelProps) {
  const { t } = useTranslation('video')
  const { theme } = useTheme()
  const { toast } = useToast()
  const [framework, setFramework] = useState<NarrativeFrameworkResponse | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await narrativeFrameworkApi.get(sessionId, taskUuid)
      setFramework(response)
      setDraft(response.content.markdown)
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error ? error.message : t('materialEditor.narrative.loadFailed'),
      })
    } finally {
      setLoading(false)
    }
  }, [sessionId, t, taskUuid, toast])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (confirmed: boolean) => {
    setSaving(true)
    try {
      const response = await narrativeFrameworkApi.update(sessionId, taskUuid, draft, confirmed)
      setFramework(response)
      setDraft(response.content.markdown)
      setEditing(false)
      toast({
        description: confirmed
          ? t('materialEditor.narrative.confirmed')
          : t('materialEditor.narrative.saved'),
      })
      if (confirmed) {
        onContinue?.(response.buttons?.[0]?.button_name)
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error ? error.message : t('materialEditor.narrative.saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div
        className="flex min-h-48 items-center justify-center"
        data-testid="material-narrative-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    )
  }

  if (!framework) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-text-secondary">
        <span>{t('materialEditor.narrative.loadFailed')}</span>
        <Button
          variant="outline"
          onClick={() => void load()}
          data-testid="material-narrative-retry"
        >
          {t('materialEditor.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="material-narrative-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {editing ? (
          <Textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            className="min-h-[480px] resize-y font-mono text-sm leading-6"
            data-testid="material-narrative-editor"
          />
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 p-5 text-sm leading-7 text-text-primary [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-3 [&_p]:mb-3 [&_ul]:mb-3">
            <EnhancedMarkdown source={draft} theme={theme} />
          </div>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
        {editing ? (
          <>
            <Button
              variant="outline"
              onClick={() => {
                setDraft(framework.content.markdown)
                setEditing(false)
              }}
              disabled={saving}
              data-testid="material-narrative-cancel"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void save(false)}
              disabled={saving || !draft.trim()}
              data-testid="material-narrative-save"
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t('materialEditor.save')}
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() => setEditing(true)}
            disabled={saving}
            data-testid="material-narrative-edit"
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t('materialEditor.narrative.edit')}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => void save(true)}
          disabled={saving || !draft.trim()}
          data-testid="material-narrative-confirm"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {framework.buttons?.[0]?.button_name || t('materialEditor.narrative.confirm')}
        </Button>
      </footer>
    </div>
  )
}
