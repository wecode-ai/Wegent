// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, Circle, Loader2 } from 'lucide-react'

import type {
  PluginPublicationCheckSeverity,
  PluginPublicationCheckStatus,
  PluginPublicationRiskLevel,
  PluginPublicationStage,
  PluginPublicationStatus,
} from '@/apis/admin-plugin-publications'
import { Tag } from '@/components/ui/tag'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const STAGES: PluginPublicationStage[] = [
  'submit_request',
  'automated_checks',
  'administrator_review',
  'code_review',
  'release',
]

function getStatusVariant(
  status: PluginPublicationStatus
): 'default' | 'success' | 'error' | 'warning' | 'info' {
  if (status === 'published') return 'success'
  if (status === 'automatic_check_failed' || status === 'publish_failed' || status === 'closed') {
    return 'error'
  }
  if (status === 'changes_requested' || status === 'code_changes_requested') return 'warning'
  if (status === 'withdrawn') return 'default'
  return 'info'
}

function getRiskVariant(
  riskLevel: PluginPublicationRiskLevel
): 'default' | 'success' | 'error' | 'warning' | 'info' {
  if (riskLevel === 'critical' || riskLevel === 'high') return 'error'
  if (riskLevel === 'medium') return 'warning'
  if (riskLevel === 'low') return 'info'
  return 'success'
}

function getCheckVariant(
  status: PluginPublicationCheckStatus
): 'default' | 'success' | 'error' | 'warning' | 'info' {
  if (status === 'passed') return 'success'
  if (status === 'blocked' || status === 'failed') return 'error'
  if (status === 'warning') return 'warning'
  if (status === 'running') return 'info'
  return 'default'
}

function getSeverityVariant(
  severity: PluginPublicationCheckSeverity
): 'default' | 'error' | 'warning' | 'info' {
  if (severity === 'blocker') return 'error'
  if (severity === 'warning') return 'warning'
  return 'info'
}

export function PluginPublicationStatusTag({ status }: { status: PluginPublicationStatus }) {
  const { t } = useTranslation('admin')
  return (
    <Tag variant={getStatusVariant(status)}>
      {t(`marketplace_management.plugin_publications.statuses.${status}`)}
    </Tag>
  )
}

export function PluginPublicationRiskTag({ riskLevel }: { riskLevel: PluginPublicationRiskLevel }) {
  const { t } = useTranslation('admin')
  return (
    <Tag variant={getRiskVariant(riskLevel)}>
      {t(`marketplace_management.plugin_publications.risks.${riskLevel}`)}
    </Tag>
  )
}

export function PluginPublicationCheckTags({
  severity,
  status,
}: {
  severity: PluginPublicationCheckSeverity
  status: PluginPublicationCheckStatus
}) {
  const { t } = useTranslation('admin')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tag variant={getSeverityVariant(severity)}>
        {t(`marketplace_management.plugin_publications.checks.severities.${severity}`)}
      </Tag>
      <Tag variant={getCheckVariant(status)}>
        {t(`marketplace_management.plugin_publications.checks.statuses.${status}`)}
      </Tag>
    </div>
  )
}

export function PluginPublicationStageProgress({
  stage,
  status,
}: {
  stage: PluginPublicationStage
  status: PluginPublicationStatus
}) {
  const { t } = useTranslation('admin')
  const currentIndex = STAGES.indexOf(stage)
  const publicationComplete = status === 'published'

  return (
    <div className="overflow-x-auto pb-2" data-testid="plugin-publication-stage-progress">
      <div className="grid min-w-[640px] grid-cols-5">
        {STAGES.map((item, index) => {
          const complete = publicationComplete || index < currentIndex
          const current = !publicationComplete && index === currentIndex

          return (
            <div key={item} className="relative flex flex-col items-center px-2 text-center">
              {index > 0 ? (
                <span
                  className={cn(
                    'absolute right-1/2 top-4 h-px w-full',
                    complete || current ? 'bg-primary' : 'bg-border'
                  )}
                  aria-hidden
                />
              ) : null}
              <span
                className={cn(
                  'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border bg-base',
                  complete && 'border-primary bg-primary text-primary-contrast',
                  current && 'border-primary text-primary',
                  !complete && !current && 'border-border text-text-muted'
                )}
              >
                {complete ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : current &&
                  ['automatic_checking', 'materializing', 'ci_running', 'publishing'].includes(
                    status
                  ) ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Circle
                    className="h-3 w-3"
                    fill={current ? 'currentColor' : 'none'}
                    aria-hidden
                  />
                )}
              </span>
              <span
                className={cn(
                  'mt-2 text-xs font-medium',
                  complete || current ? 'text-text-primary' : 'text-text-muted'
                )}
              >
                {t(`marketplace_management.plugin_publications.stages.${item}`)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
