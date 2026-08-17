// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, ExternalLink, Loader2, Plus, RotateCcw } from 'lucide-react'

import type { MarketSkill } from '@/apis/skillMarketplace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ResourceIcon } from './ResourceIcon'

interface SkillMarketplaceCardProps {
  skill: MarketSkill
  installStatus?: {
    status: 'downloading' | 'installing' | 'success' | 'error'
    error?: string
  }
  onInstall: (skill: MarketSkill) => void
}

function formatDownloadCount(count: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: count >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(count)
}

export function SkillMarketplaceCard({
  skill,
  installStatus,
  onInstall,
}: SkillMarketplaceCardProps) {
  const { t } = useTranslation('resource-library')
  const isInstalling =
    installStatus?.status === 'downloading' || installStatus?.status === 'installing'
  const isInstalled = installStatus?.status === 'success'
  const isError = installStatus?.status === 'error'
  const needsPermission = skill.visibility !== 'public' && !skill.hasDownloadPermission
  const actionLabel = isInstalled
    ? t('external_skill_market.installed')
    : isError
      ? t('external_skill_market.retry')
      : needsPermission
        ? t('external_skill_market.request_permission')
        : t('external_skill_market.install')

  const handleAction = () => {
    if (needsPermission) {
      if (skill.permissionUrl) {
        window.open(skill.permissionUrl, '_blank', 'noopener,noreferrer')
      }
      return
    }
    onInstall(skill)
  }

  return (
    <Card
      className="group relative flex h-full min-h-[180px] flex-col gap-3 overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
      data-testid={`skill-marketplace-card-${skill.skillKey}`}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn(
          'absolute right-3 top-3 z-10 h-11 w-11 px-0 md:h-8 md:w-8',
          !isInstalled &&
            !isError &&
            !needsPermission &&
            'border-primary/20 bg-primary/[0.04] text-primary shadow-sm hover:border-primary/40 hover:bg-primary/[0.1] hover:shadow-md',
          isInstalled && 'text-success',
          isError && 'text-error'
        )}
        disabled={isInstalling || isInstalled || (needsPermission && !skill.permissionUrl)}
        onClick={handleAction}
        aria-label={`${actionLabel} ${skill.name}`}
        title={actionLabel}
        data-testid={`install-market-skill-${skill.skillKey}`}
      >
        {isInstalling ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : isInstalled ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : isError ? (
          <RotateCcw className="h-4 w-4" aria-hidden />
        ) : needsPermission ? (
          <ExternalLink className="h-4 w-4" aria-hidden />
        ) : (
          <Plus className="h-4 w-4" aria-hidden />
        )}
      </Button>

      <div className="flex min-w-0 items-start gap-3 pr-12">
        <ResourceIcon
          resourceType="skill"
          name={skill.name}
          marketplaceTags={skill.tags}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{skill.name}</h3>
            {skill.visibility !== 'public' && (
              <Badge variant="secondary" size="sm">
                {t('external_skill_market.private_skill')}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {skill.author}
            {skill.version ? ` · v${skill.version}` : ''}
          </p>
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {skill.description || skill.name}
      </p>

      {skill.tags.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          data-testid={`skill-marketplace-tags-${skill.skillKey}`}
        >
          {skill.tags.slice(0, 3).map(tag => (
            <Badge key={tag} variant="secondary" size="sm">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-auto min-w-0 pt-1 text-xs text-text-muted">
        {t('external_skill_market.download_count', {
          count: formatDownloadCount(skill.downloadCount),
        })}
      </div>

      {isError && installStatus?.error && (
        <p className="line-clamp-2 text-xs text-error" title={installStatus.error}>
          {installStatus.error}
        </p>
      )}
    </Card>
  )
}
