// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { UnifiedSkill } from '@/apis/skills'
import {
  getResourceCardActionsClassName,
  getResourceCardClassName,
  ResourceCardIcon,
} from '@/components/common/resourceCardLayout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import { Code2, Settings2 } from 'lucide-react'

interface InstalledSkillCardProps {
  skill: UnifiedSkill
  sourceLabel: string
  sourceVariant: 'info' | 'success' | 'secondary'
  isUpdating: boolean
  onConfigure: () => void
  onDisable: () => void
}

export function InstalledSkillCard({
  skill,
  sourceLabel,
  sourceVariant,
  isUpdating,
  onConfigure,
  onDisable,
}: InstalledSkillCardProps) {
  const { t: tSettings } = useTranslation('settings')
  const title = skill.displayName || skill.name

  return (
    <Card
      className={`${getResourceCardClassName(true)} group relative gap-3`}
      data-testid={`installed-skill-card-${skill.id}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <ResourceCardIcon compact>
          <Code2 className="h-5 w-5 text-primary" aria-hidden />
        </ResourceCardIcon>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate font-semibold text-text-primary" title={title}>
              {title}
            </h3>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant={sourceVariant}>{sourceLabel}</Badge>
            {skill.version && <span className="text-xs text-text-muted">v{skill.version}</span>}
          </div>
        </div>
        <div
          className="relative z-20 ml-auto flex shrink-0 items-center gap-1"
          data-testid={`installed-skill-actions-${skill.id}`}
        >
          <span className="flex h-11 w-11 items-center justify-center md:h-9 md:w-9">
            <span className="sr-only">{tSettings('skills.availability.inMyDefault')}</span>
            <Switch
              checked
              onCheckedChange={onDisable}
              disabled={isUpdating}
              aria-label={tSettings('skills.availability.removeFromMyDefault')}
              title={tSettings('skills.availability.inMyDefault')}
              data-testid={`remove-skill-default-button-${skill.id}`}
            />
          </span>
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {skill.description || skill.name}
      </p>

      <div
        className={`relative z-20 ${getResourceCardActionsClassName(true)}`}
        data-testid={`installed-skill-footer-actions-${skill.id}`}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={onConfigure}
          className="h-11 w-full gap-2 text-xs md:h-8"
          title={tSettings('skills.autoSettings.configure')}
          data-testid={`configure-installed-skill-${skill.id}`}
        >
          <Settings2 className="h-4 w-4" />
          <span>{tSettings('skills.autoSettings.configure')}</span>
        </Button>
      </div>
    </Card>
  )
}
