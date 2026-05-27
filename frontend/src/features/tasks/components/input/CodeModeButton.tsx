// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Code } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { ActionButton } from '@/components/ui/action-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

export function CodeModeButton() {
  const router = useRouter()
  const { t } = useTranslation()
  const label = t('common:navigation.code')

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              onClick={() => router.push(paths.code.getHref())}
              icon={<Code className="h-4 w-4" />}
              title={label}
              data-testid="code-mode-button"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default CodeModeButton
