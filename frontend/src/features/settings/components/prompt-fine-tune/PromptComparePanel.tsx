// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { FileText, RotateCcw, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PromptComparePanelProps {
  originalPrompt: string
  currentPrompt: string
  onPromptChange: (prompt: string) => void
  onReset: () => void
}

export default function PromptComparePanel({
  originalPrompt,
  currentPrompt,
  onPromptChange,
  onReset,
}: PromptComparePanelProps) {
  const { t } = useTranslation('wizard')

  // Check if prompt has been modified
  const isModified = useMemo(() => {
    return originalPrompt !== currentPrompt
  }, [originalPrompt, currentPrompt])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0">
        <Label className="text-sm font-medium flex items-center gap-2">
          <FileText className="w-4 h-4 text-text-secondary" />
          {t('promptTune:compare.current')}
          {isModified && (
            <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              {t('promptTune:compare.modified')}
            </span>
          )}
        </Label>
        {isModified && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 text-xs text-text-muted hover:text-text-primary"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            {t('promptTune:actions.reset')}
          </Button>
        )}
      </div>

      {/* Current Prompt Editor */}
      <div className="flex-1 p-3 overflow-hidden flex flex-col min-h-0">
        <Textarea
          value={currentPrompt}
          onChange={e => onPromptChange(e.target.value)}
          className="flex-1 min-h-0 font-mono text-sm resize-none"
          placeholder={t('wizard:system_prompt_placeholder')}
        />
      </div>

      {/* Original Prompt Preview (collapsible) */}
      {isModified && (
        <div className="border-t border-border flex-shrink-0">
          <details className="group">
            <summary className="flex items-center gap-2 p-3 cursor-pointer text-sm text-text-muted hover:text-text-primary select-none">
              <Eye className="w-4 h-4" />
              <span>{t('promptTune:compare.original')}</span>
              <span className="text-xs">({t('promptTune:compare.click_to_expand')})</span>
            </summary>
            <div className="p-3 pt-0 max-h-[200px] overflow-y-auto">
              <div className="bg-muted/50 rounded-md p-3 font-mono text-xs text-text-muted whitespace-pre-wrap">
                {originalPrompt}
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
