// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { ArrowUpRight, Boxes } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

const RESOURCE_LIBRARY_HREF = '/resource-library'

export function SettingsResourceGuide() {
  const { t } = useTranslation('settings')
  const usesEnglish = t('title') === 'Settings'
  const translateWithFallback = (key: string, fallbackZh: string, fallbackEn: string) => {
    const fallback = usesEnglish ? fallbackEn : fallbackZh
    const translated = t(key)
    return translated === key ? fallback : translated
  }

  return (
    <section
      aria-labelledby="settings-resource-guide-title"
      className="rounded-lg border border-border bg-surface p-4"
      data-testid="settings-resource-guide"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Boxes className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="settings-resource-guide-title" className="text-sm font-semibold">
              {translateWithFallback(
                'resourceGuide.title',
                '资源管理已移到资源库',
                'Resource management moved to Resource Library'
              )}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {translateWithFallback(
                'resourceGuide.description',
                '智能体、模型、执行器、技能和检索器现在在资源库管理。',
                'Agents, models, executors, skills, and retrievers are now managed in Resource Library.'
              )}
            </p>
          </div>
        </div>

        <Button asChild type="button" variant="outline" size="sm" className="h-9 min-w-[44px] px-3">
          <Link href={RESOURCE_LIBRARY_HREF}>
            {translateWithFallback('resourceGuide.action', '前往资源库', 'Go to Resource Library')}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  )
}

export default SettingsResourceGuide
