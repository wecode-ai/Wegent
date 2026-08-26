// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, Loader2, Pencil, RefreshCw, Save, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { scriptApi } from './api'
import type { ScriptDetail } from './types'

interface ScriptPanelProps {
  scriptId: number
  onClose: () => void
  children?: ReactNode
}

export function ScriptPanel({ scriptId, onClose, children }: ScriptPanelProps) {
  const { t } = useTranslation('video')
  const { theme } = useTheme()
  const { toast } = useToast()
  const [script, setScript] = useState<ScriptDetail | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadScript = useCallback(async () => {
    setLoading(true)
    try {
      const response = await scriptApi.getScript(scriptId)
      const draftContent = response.draft_content ?? ''
      setScript(response)
      setContent(draftContent)
      setSavedContent(draftContent)
      setLoadFailed(false)
    } catch (error) {
      console.error('Failed to load script detail:', error)
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [scriptId])

  useEffect(() => {
    void loadScript()
  }, [loadScript])

  const handleCancel = () => {
    setContent(savedContent)
    setEditing(false)
  }

  const handleSave = async () => {
    if (!script || content === savedContent) return
    setSaving(true)
    try {
      const response = await scriptApi.updateDraftScript(script.script_id, {
        draft_content: content,
      })
      setSavedContent(content)
      setScript(current =>
        current
          ? {
              ...current,
              draft_content: content,
              update_time: response.update_time,
            }
          : current
      )
      setEditing(false)
      toast({ description: t('script.saveSuccess') })
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('script.saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = content !== savedContent
  const canEdit = Boolean(script && script.is_draft !== false)
  const updatedAt = script?.update_time ? new Date(script.update_time) : null
  const validUpdatedAt = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="video-script-panel">
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-text-primary">
            {script?.title || t('script.title')}
          </h3>
          {validUpdatedAt ? (
            <p className="mt-0.5 text-xs text-text-secondary">
              {t('script.updatedAt', {
                time: validUpdatedAt.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-2">
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11"
                  onClick={handleCancel}
                  disabled={saving}
                  data-testid="script-cancel-edit"
                >
                  <X className="h-4 w-4" />
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void handleSave()}
                  disabled={!hasChanges || saving}
                  data-testid="script-save"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? t('script.saving') : t('script.save')}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => setEditing(true)}
                data-testid="script-edit"
              >
                <Pencil className="h-4 w-4" />
                {t('script.edit')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={onClose}
              aria-label={t('close')}
              data-testid="aigc-video-panel-close"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={onClose}
            aria-label={t('close')}
            data-testid="aigc-video-panel-close"
          >
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary"
            data-testid="video-script-panel-loading"
          >
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            {t('script.loading')}
          </div>
        ) : loadFailed ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
            data-testid="video-script-panel-error"
          >
            <FileText className="h-9 w-9 text-text-muted" />
            <p className="text-sm text-text-secondary">{t('script.loadFailed')}</p>
            <Button variant="primary" onClick={() => void loadScript()} data-testid="script-retry">
              <RefreshCw className="h-4 w-4" />
              {t('script.retry')}
            </Button>
          </div>
        ) : editing ? (
          <Textarea
            value={content}
            onChange={event => setContent(event.target.value)}
            className="min-h-full resize-none font-mono leading-6"
            aria-label={t('script.editorLabel')}
            data-testid="script-editor"
          />
        ) : content ? (
          <div
            className="text-sm leading-6 text-text-primary [&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-3 [&_p]:mb-3 [&_ul]:mb-3"
            data-testid="script-full-content"
          >
            <EnhancedMarkdown source={content} theme={theme} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            {t('script.empty')}
          </div>
        )}
      </div>

      {script && children ? (
        <div className="shrink-0 border-t border-border px-5 py-4">{children}</div>
      ) : null}
    </div>
  )
}
