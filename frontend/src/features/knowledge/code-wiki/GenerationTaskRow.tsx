// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { HelpCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { useTranslation } from '@/hooks/useTranslation'

interface GenerationTaskRowProps {
  checked: boolean
  onChange: (checked: boolean) => void
}

/**
 * Whether this wiki's generation runs are listed as conversations.
 *
 * The why is behind a tooltip rather than printed under the label. It is three
 * sentences — a wiki regenerates on its own, the runs would bury real
 * conversations, they stay visible in the history — and a row that explains itself
 * at that length is longer than the setting it describes.
 *
 * Lives in advanced settings, and in both dialogs. It was only offered at creation,
 * which made a display preference into something a wiki was built with: a reader who
 * wanted to watch one run had no way to see it short of building the wiki again.
 */
export function GenerationTaskRow({ checked, onChange }: GenerationTaskRowProps) {
  const { t } = useTranslation()

  return (
    <SimpleConfigRow
      label={
        <span className="flex items-center gap-1.5">
          {t('knowledge:codeWiki.create.showGenerationTask')}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('knowledge:codeWiki.create.showGenerationTaskHint')}
                  data-testid="code-wiki-show-generation-task-help"
                  className="text-text-muted hover:text-text-secondary"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t('knowledge:codeWiki.create.showGenerationTaskHint')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
      }
    >
      <div className="flex justify-end">
        <Switch
          id="code-wiki-show-generation-task"
          data-testid="code-wiki-show-generation-task"
          checked={checked}
          onCheckedChange={onChange}
        />
      </div>
    </SimpleConfigRow>
  )
}
