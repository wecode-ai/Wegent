// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { UnifiedSkill } from '@/apis/skills'
import { ResourceCardFooter } from '@/components/common/ResourceCardFooter'
import { ResourceCardIcon } from '@/components/common/resourceCardLayout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import { Code2, MoreHorizontal, Settings2 } from 'lucide-react'

interface InstalledSkillCardProps {
  skill: UnifiedSkill
  sourceLabel: string
  sourceVariant: 'info' | 'success' | 'secondary'
  owner?: string | null
  isUpdating: boolean
  onConfigure: () => void
  onDisable: () => void
}

export function InstalledSkillCard({
  skill,
  sourceLabel,
  sourceVariant,
  owner,
  isUpdating,
  onConfigure,
  onDisable,
}: InstalledSkillCardProps) {
  const { t } = useTranslation('common')
  const { t: tSettings } = useTranslation('settings')
  const title = skill.displayName || skill.name
  const tags = skill.tags || []

  return (
    <Card
      className="group relative flex min-h-[180px] flex-col gap-4 overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
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
            <div className="flex min-h-11 shrink-0 items-center gap-1 md:h-6 md:min-h-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 opacity-100 transition-opacity md:pointer-events-none md:h-7 md:w-7 md:opacity-0 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:opacity-100"
                    aria-label={t('teams.more_actions')}
                    data-testid={`installed-skill-more-button-${skill.id}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    onClick={onConfigure}
                    data-testid={`configure-installed-skill-${skill.id}`}
                  >
                    <Settings2 className="mr-2 h-4 w-4" />
                    {tSettings('skills.autoSettings.configure')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Switch
                checked
                onCheckedChange={onDisable}
                disabled={isUpdating}
                aria-label={tSettings('skills.availability.removeFromMyDefault')}
                title={tSettings('skills.availability.inMyDefault')}
                data-testid={`remove-skill-default-button-${skill.id}`}
              />
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant={sourceVariant}>{sourceLabel}</Badge>
            {skill.version && <span className="text-xs text-text-muted">v{skill.version}</span>}
          </div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {skill.description || skill.name}
      </p>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.slice(0, 2).map(tag => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <ResourceCardFooter
        owner={owner}
        updatedAt={skill.updated_at}
        testId={`installed-skill-footer-${skill.id}`}
      />
    </Card>
  )
}
