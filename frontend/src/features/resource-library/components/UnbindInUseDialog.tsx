// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { AlertTriangle, Bot, BookOpen } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/hooks/useTranslation'

type UnbindConsumerType = 'agent' | 'knowledge-base'

interface UnbindInUseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  consumerType: UnbindConsumerType
  consumerNames: string[]
}

const consumerConfig = {
  agent: {
    summaryKey: 'common:actions.unbind_shell_in_use_summary',
    guidanceKey: 'common:actions.unbind_shell_in_use_guidance',
    actionKey: 'common:actions.go_to_agents',
    href: '/resource-library?type=agent&tab=mine',
    Icon: Bot,
  },
  'knowledge-base': {
    summaryKey: 'common:actions.unbind_retriever_in_use_summary',
    guidanceKey: 'common:actions.unbind_retriever_in_use_guidance',
    actionKey: 'common:actions.go_to_knowledge_bases',
    href: '/knowledge?type=document',
    Icon: BookOpen,
  },
} as const

export function UnbindInUseDialog({
  open,
  onOpenChange,
  consumerType,
  consumerNames,
}: UnbindInUseDialogProps) {
  const { t } = useTranslation()
  const config = consumerConfig[consumerType]
  const ConsumerIcon = config.Icon

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-3 text-left">
              <AlertDialogTitle>{t('common:actions.unbind_in_use_title')}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p className="text-text-secondary">
                    {t(config.summaryKey, { count: consumerNames.length })}
                  </p>
                  <div
                    className="max-h-40 overflow-y-auto rounded-lg border border-border bg-surface"
                    role="list"
                  >
                    {consumerNames.map((name, index) => (
                      <div
                        key={`${name}-${index}`}
                        className="flex min-h-11 items-start gap-2 border-b border-border px-3 py-2.5 last:border-b-0"
                        role="listitem"
                      >
                        <ConsumerIcon
                          className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 break-words font-semibold text-text-primary">
                          {name}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-text-muted">{t(config.guidanceKey)}</p>
                </div>
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.got_it')}</AlertDialogCancel>
          <AlertDialogAction variant="primary" asChild>
            <Link href={config.href} data-testid={`go-to-${consumerType}-button`}>
              {t(config.actionKey)}
            </Link>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
