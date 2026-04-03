// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo } from 'react'
import { FolderOutput, Users, Building2, AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBase } from '@/types/knowledge'

/** Available group for migration target */
export interface MigrationTargetGroup {
  id: string
  name: string
  displayName: string
  type: 'group' | 'organization'
}

interface MigrateKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  availableGroups: MigrationTargetGroup[]
  onMigrate: (targetGroupName: string) => Promise<void>
  loading?: boolean
}

/** Get icon for group type */
function GroupTypeIcon({ type }: { type: 'group' | 'organization' }) {
  switch (type) {
    case 'organization':
      return <Building2 className="w-4 h-4" />
    case 'group':
    default:
      return <Users className="w-4 h-4" />
  }
}

export function MigrateKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  availableGroups,
  onMigrate,
  loading,
}: MigrateKnowledgeBaseDialogProps) {
  const { t } = useTranslation('knowledge')
  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const [error, setError] = useState('')

  // Reset state when dialog opens
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSelectedGroupId('')
      setError('')
    }
    onOpenChange(newOpen)
  }

  // Filter to only show group and organization types (not personal)
  const validTargetGroups = useMemo(() => {
    return availableGroups.filter(g => g.type === 'group' || g.type === 'organization')
  }, [availableGroups])

  const handleMigrate = async () => {
    setError('')

    if (!selectedGroupId) {
      setError(t('document.migrate.selectGroupRequired', '请选择目标群组'))
      return
    }

    const selectedGroup = validTargetGroups.find(g => g.id === selectedGroupId)
    if (!selectedGroup) {
      setError(t('document.migrate.invalidGroup', '无效的目标群组'))
      return
    }

    try {
      await onMigrate(selectedGroup.name)
      handleOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" data-testid="migrate-kb-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOutput className="w-5 h-5 text-primary" />
            {t('document.migrate.title', '迁移知识库')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'document.migrate.description',
              '将个人知识库迁移到群组，迁移后该知识库将属于目标群组'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Knowledge base info */}
          {knowledgeBase && (
            <div className="bg-surface p-3 rounded-md border border-border">
              <div className="text-sm text-text-secondary">
                {t('document.migrate.sourceKnowledgeBase', '待迁移知识库')}
              </div>
              <div className="font-medium text-text-primary mt-1">{knowledgeBase.name}</div>
            </div>
          )}

          {/* Target group selector */}
          <div className="space-y-2">
            <Label>{t('document.migrate.targetGroup', '目标群组')} *</Label>
            <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
              <SelectTrigger data-testid="migrate-target-group">
                <SelectValue
                  placeholder={t('document.migrate.selectGroupPlaceholder', '选择要迁移到的群组')}
                />
              </SelectTrigger>
              <SelectContent>
                {validTargetGroups.length === 0 ? (
                  <div className="px-2 py-4 text-sm text-text-muted text-center">
                    {t(
                      'document.migrate.noAvailableGroups',
                      '没有可迁移的群组，请先加入或创建一个群组'
                    )}
                  </div>
                ) : (
                  validTargetGroups.map(group => (
                    <SelectItem key={group.id} value={group.id}>
                      <div className="flex items-center gap-2">
                        <GroupTypeIcon type={group.type} />
                        <span>{group.displayName}</span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Warning note */}
          <div className="flex items-start gap-2 text-sm text-text-muted bg-surface p-3 rounded-md">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p>{t('document.migrate.permissionNote', '您需要是目标群组的管理员才能执行迁移')}</p>
              <p className="mt-1">
                {t(
                  'document.migrate.migrationNote',
                  '迁移后，该知识库将从个人知识库移动到群组知识库，原分享权限将保留'
                )}
              </p>
            </div>
          </div>

          {error && <p className="text-sm text-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
            className="h-11 min-w-[44px]"
            data-testid="cancel-migrate-kb"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={handleMigrate}
            variant="primary"
            disabled={loading || !selectedGroupId || validTargetGroups.length === 0}
            className="h-11 min-w-[44px]"
            data-testid="confirm-migrate-kb"
          >
            {loading
              ? t('document.migrate.migrating', '迁移中...')
              : t('document.migrate.confirm', '确认迁移')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
