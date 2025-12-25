// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  ServerIcon,
  PackageIcon,
  WrenchIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  XCircleIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { GhostSkill, SkillStatus, SkillType } from '@/types/skill'
import {
  listGhostSkills,
  removeSkillFromGhost,
  updateGhostSkillStatus,
} from '@/apis/skills'
import LoadingState from '@/features/common/LoadingState'
import SkillMarketDialog from './SkillMarketDialog'
import SkillConfigDialog from './SkillConfigDialog'

interface GhostSkillListProps {
  ghostId: number
  ghostName: string
  onSkillsChange?: () => void
}

export default function GhostSkillList({
  ghostId,
  ghostName,
  onSkillsChange,
}: GhostSkillListProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [skills, setSkills] = useState<GhostSkill[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [marketDialogOpen, setMarketDialogOpen] = useState(false)
  const [configDialogOpen, setConfigDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<GhostSkill | null>(null)

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    try {
      const skillsData = await listGhostSkills(ghostId)
      setSkills(skillsData)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_load'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [ghostId, toast, t])

  useEffect(() => {
    if (ghostId) {
      loadSkills()
    }
  }, [ghostId, loadSkills])

  const handleRemoveSkill = async (skill: GhostSkill) => {
    try {
      await removeSkillFromGhost(ghostId, skill.name)
      toast({
        title: t('common.success'),
        description: t('tools.tool_removed', { toolName: skill.name }),
      })
      await loadSkills()
      onSkillsChange?.()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_remove'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    }
  }

  const handleToggleStatus = async (skill: GhostSkill) => {
    const newStatus: SkillStatus =
      skill.status === 'disabled' ? 'available' : 'disabled'

    try {
      await updateGhostSkillStatus(ghostId, skill.name, newStatus)
      toast({
        title: t('common.success'),
        description: t('tools.status_updated'),
      })
      await loadSkills()
      onSkillsChange?.()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_update'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    }
  }

  const handleConfigureSkill = (skill: GhostSkill) => {
    setSelectedSkill(skill)
    setConfigDialogOpen(true)
  }

  const handleMarketClose = (added: boolean) => {
    setMarketDialogOpen(false)
    if (added) {
      loadSkills()
      onSkillsChange?.()
    }
  }

  const handleConfigClose = (saved: boolean) => {
    setConfigDialogOpen(false)
    setSelectedSkill(null)
    if (saved) {
      loadSkills()
      onSkillsChange?.()
    }
  }

  const getSkillTypeIcon = (skillType: SkillType) => {
    switch (skillType) {
      case 'mcp':
        return <ServerIcon className="w-4 h-4" />
      case 'builtin':
        return <WrenchIcon className="w-4 h-4" />
      case 'skill':
      default:
        return <PackageIcon className="w-4 h-4" />
    }
  }

  const getStatusIcon = (status: SkillStatus) => {
    switch (status) {
      case 'available':
        return <CheckCircleIcon className="w-4 h-4 text-success" />
      case 'pending_config':
        return <AlertCircleIcon className="w-4 h-4 text-warning" />
      case 'disabled':
        return <XCircleIcon className="w-4 h-4 text-text-muted" />
      default:
        return null
    }
  }

  const getStatusText = (status: SkillStatus) => {
    switch (status) {
      case 'available':
        return t('tools.status_available')
      case 'pending_config':
        return t('tools.status_pending_config')
      case 'disabled':
        return t('tools.status_disabled')
      default:
        return status
    }
  }

  const getSkillTypeText = (skillType: SkillType) => {
    switch (skillType) {
      case 'mcp':
        return t('tools.type_mcp')
      case 'builtin':
        return t('tools.type_builtin')
      case 'skill':
      default:
        return t('tools.type_skill')
    }
  }

  if (isLoading) {
    return <LoadingState message={t('tools.loading')} />
  }

  return (
    <div className="space-y-4">
      {/* Header with Add Button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">{t('tools.tools_title')}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMarketDialogOpen(true)}
          className="gap-1"
        >
          <PlusIcon className="w-4 h-4" />
          {t('tools.add_tool')}
        </Button>
      </div>

      {/* Skills List */}
      {skills.length === 0 ? (
        <Card className="p-6 text-center border-dashed">
          <ServerIcon className="w-10 h-10 mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary mb-2">{t('tools.no_tools_added')}</p>
          <p className="text-xs text-text-muted mb-4">{t('tools.no_tools_hint')}</p>
          <Button variant="outline" size="sm" onClick={() => setMarketDialogOpen(true)}>
            <PlusIcon className="w-4 h-4 mr-1" />
            {t('tools.add_tool')}
          </Button>
        </Card>
      ) : (
        <div className="space-y-2">
          {skills.map(skill => (
            <Card
              key={skill.id}
              className={`p-3 transition-all ${
                skill.status === 'disabled' ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-start gap-3">
                {/* Icon */}
                <div className="flex-shrink-0 p-2 bg-surface-elevated rounded-md">
                  {getSkillTypeIcon(skill.skillType)}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-text-primary truncate">
                      {skill.name}
                    </h4>
                    {getStatusIcon(skill.status)}
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">
                    {skill.description}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Tag variant="default" className="text-xs">
                      {getSkillTypeText(skill.skillType)}
                    </Tag>
                    <Tag
                      variant={
                        skill.status === 'available'
                          ? 'success'
                          : skill.status === 'pending_config'
                            ? 'warning'
                            : 'default'
                      }
                      className="text-xs"
                    >
                      {getStatusText(skill.status)}
                    </Tag>
                    {skill.category && (
                      <Tag variant="info" className="text-xs">
                        {skill.category}
                      </Tag>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-1 flex-shrink-0">
                  {/* Configure button - only for MCP skills that need config */}
                  {skill.skillType === 'mcp' && skill.mcpConfig?.envSchema && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleConfigureSkill(skill)}
                      title={t('tools.configure')}
                    >
                      <SettingsIcon className="w-4 h-4" />
                    </Button>
                  )}
                  {/* Toggle status button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleToggleStatus(skill)}
                    title={
                      skill.status === 'disabled'
                        ? t('tools.enable')
                        : t('tools.disable')
                    }
                  >
                    {skill.status === 'disabled' ? (
                      <CheckCircleIcon className="w-4 h-4" />
                    ) : (
                      <XCircleIcon className="w-4 h-4" />
                    )}
                  </Button>
                  {/* Remove button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                    onClick={() => handleRemoveSkill(skill)}
                    title={t('tools.remove')}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Market Dialog */}
      <SkillMarketDialog
        open={marketDialogOpen}
        onClose={handleMarketClose}
        ghostId={ghostId}
        existingSkillNames={skills.map(s => s.name)}
      />

      {/* Config Dialog */}
      {selectedSkill && (
        <SkillConfigDialog
          open={configDialogOpen}
          onClose={handleConfigClose}
          ghostId={ghostId}
          skill={selectedSkill}
        />
      )}
    </div>
  )
}
