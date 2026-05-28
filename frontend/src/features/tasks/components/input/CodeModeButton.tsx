// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Code, X } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { ActionButton } from '@/components/ui/action-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

export function CodeModeButton() {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useTranslation()
  const label = t('common:navigation.code')
  const closeLabel = t('common:actions.close')
  const codePath = paths.code.getHref()
  const isActive = pathname === codePath || pathname?.startsWith(`${codePath}/`)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            {isActive ? (
              <div
                className="inline-flex h-9 items-center overflow-hidden rounded-[24px] bg-primary text-white"
                data-testid="code-mode-active-control"
              >
                <button
                  type="button"
                  onClick={() => router.push(paths.code.getHref())}
                  title={label}
                  aria-current="page"
                  className="inline-flex h-9 items-center justify-center gap-1 rounded-l-[24px] bg-primary pl-2.5 pr-1 text-sm text-white ring-offset-base transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  data-testid="code-mode-button"
                >
                  <Code className="h-4 w-4" />
                  <span className="text-sm text-white">{label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => router.push(paths.chat.getHref())}
                  aria-label={closeLabel}
                  title={closeLabel}
                  className="inline-flex h-9 w-8 items-center justify-center rounded-r-[24px] text-white ring-offset-base transition-colors hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  data-testid="code-mode-close-button"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <ActionButton
                onClick={() => router.push(paths.code.getHref())}
                icon={<Code className="h-4 w-4" />}
                label={label}
                title={label}
                data-testid="code-mode-button"
              />
            )}
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
