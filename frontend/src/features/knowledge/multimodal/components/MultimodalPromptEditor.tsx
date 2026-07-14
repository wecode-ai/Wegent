// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { getMultimodalDefaultPrompts } from '@/apis/knowledge'
import { resolveEffectivePrompt, type PromptSource } from '../utils/resolveMultimodalPrompt'

/**
 * Maximum length (chars) for a custom multimodal analysis prompt. Enforced in
 * the textarea (maxLength) and shown as a live counter. Applies uniformly to
 * all three entry points (KB create/edit, upload advanced settings, per-doc
 * re-analyze) since they all render this editor.
 */
const MAX_PROMPT_LENGTH = 2000

interface MultimodalPromptEditorProps {
  /**
   * Media type this editor is for. In the KB form there are two editors
   * (video + image); in the upload/re-analyze dialogs there is one (the
   * current document/batch media type).
   */
  mediaType: 'video' | 'image'
  /**
   * The customized prompt value (from KB spec or document source_config).
   * null/undefined/'' = "use system default" (not customized).
   */
  value: string | null | undefined
  /** Called with the new value whenever the user edits (null = reset). */
  onChange: (value: string | null) => void
  /**
   * Whether the editor is editing a KB-level default (two-editor form). When
   * false, the editor is document-scoped (upload / re-analyze) and shows an
   * inherited-from-KB source label instead of "customized".
   */
  scope: 'knowledge' | 'document'
  /** KB-level prompt (used only when scope === 'document' to resolve inheritance). */
  kbPrompt?: string | null | undefined
  /** Optional id suffix for the textarea element. */
  idSuffix?: string
}

const sourceBadgeClass: Record<PromptSource, string> = {
  document: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  knowledge: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  system: 'bg-surface text-text-muted',
}

export function MultimodalPromptEditor({
  mediaType,
  value,
  onChange,
  scope,
  kbPrompt,
  idSuffix,
}: MultimodalPromptEditorProps) {
  const { t } = useTranslation('knowledge')
  const [defaults, setDefaults] = useState<string | null>(null)
  // Whether the user has a non-blank override stored. Derived directly from
  // `value` (not held in state) so it always reflects the latest prop — this
  // avoids stale badges/disabled-state when the editor is reused across
  // documents or the KB loads asynchronously after mount.
  const customized = Boolean(value && value.trim())
  const systemDefaultRef = useRef<string>('')
  const loaded = defaults !== null

  useEffect(() => {
    let mounted = true
    getMultimodalDefaultPrompts()
      .then(d => {
        if (!mounted) return
        const sys = mediaType === 'video' ? d.video_prompt : d.image_prompt
        systemDefaultRef.current = sys
        setDefaults(sys)
      })
      .catch(() => {
        if (!mounted) return
        setDefaults('')
      })
    return () => {
      mounted = false
    }
  }, [mediaType])

  // Resolve the effective prompt for display + source label.
  const resolved = useMemo<ReturnType<typeof resolveEffectivePrompt> | null>(() => {
    if (!loaded) return null
    // For KB-scope editors there is no document layer; the "value" IS the KB layer.
    if (scope === 'knowledge') {
      return resolveEffectivePrompt(mediaType, null, value, {
        video_prompt: systemDefaultRef.current,
        image_prompt: systemDefaultRef.current,
      })
    }
    // Document scope: value is the document override; kbPrompt is inheritance.
    return resolveEffectivePrompt(mediaType, value, kbPrompt, {
      video_prompt: systemDefaultRef.current,
      image_prompt: systemDefaultRef.current,
    })
  }, [loaded, scope, mediaType, value, kbPrompt])

  // Working text: the effective prompt (the stored override when present, else
  // the inherited/default value) so the textarea always shows what will run.
  const workingText = resolved?.text ?? ''

  if (!loaded || !resolved) {
    return (
      <div className="space-y-2">
        <Textarea rows={4} disabled placeholder={t('document.multimodal.loadingPrompt')} />
      </div>
    )
  }

  const handleTextChange = (text: string) => {
    onChange(text)
  }

  const handleReset = () => {
    // Clear the override → parent stores null → falls back to KB/system default.
    onChange(null)
  }

  const badgeLabel = (() => {
    if (scope === 'document') {
      // For document scope the source describes where the *inherited* value comes from.
      if (resolved.source === 'document') return t('document.multimodal.promptSource.document')
      if (resolved.source === 'knowledge') return t('document.multimodal.promptSource.knowledge')
      return t('document.multimodal.promptSource.knowledgeDefault')
    }
    return customized
      ? t('document.multimodal.promptSource.customized')
      : t('document.multimodal.promptSource.system')
  })()

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium',
            sourceBadgeClass[resolved.source]
          )}
        >
          {badgeLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={!customized}
          data-testid={`multimodal-prompt-reset-${idSuffix ?? mediaType}`}
          className="h-7 text-xs"
        >
          {scope === 'document'
            ? t('document.multimodal.resetToInherited')
            : t('document.multimodal.resetToDefault')}
        </Button>
      </div>
      <Textarea
        id={`multimodal-prompt-${idSuffix ?? mediaType}`}
        value={workingText}
        onChange={e => handleTextChange(e.target.value)}
        rows={6}
        maxLength={MAX_PROMPT_LENGTH}
        placeholder={t('document.multimodal.promptPlaceholder')}
        data-testid={`multimodal-prompt-textarea-${idSuffix ?? mediaType}`}
        className="bg-base font-mono text-xs"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {mediaType === 'video'
            ? t('document.multimodal.videoPromptHint')
            : t('document.multimodal.imagePromptHint')}
        </p>
        <span
          className={cn(
            'text-xs tabular-nums',
            workingText.length > MAX_PROMPT_LENGTH * 0.9 ? 'text-amber-600' : 'text-text-muted'
          )}
        >
          {workingText.length}/{MAX_PROMPT_LENGTH}
        </span>
      </div>
    </div>
  )
}
