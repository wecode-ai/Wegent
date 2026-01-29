// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { UsersRound, Loader2 } from 'lucide-react'
import { PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
import { adminApis, AdminPublicTeam } from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import PublicTeamEditDialog from './PublicTeamEditDialog'

const PublicTeamList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [teams, setTeams] = useState<AdminPublicTeam[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState<AdminPublicTeam | null>(null)
  const [saving, setSaving] = useState(false)

  const fetchTeams = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPublicTeams(page, 100)
      setTeams(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('public_teams.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  useEffect(() => {
    fetchTeams()
  }, [fetchTeams])

  const handleDeleteTeam = async () => {
    if (!selectedTeam) return

    setSaving(true)
    try {
      await adminApis.deletePublicTeam(selectedTeam.id)
      toast({ title: t('public_teams.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedTeam(null)
      fetchTeams()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_teams.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const openCreateDialog = () => {
    setSelectedTeam(null)
    setIsEditDialogOpen(true)
  }

  const openEditDialog = (team: AdminPublicTeam) => {
    setSelectedTeam(team)
    setIsEditDialogOpen(true)
  }

  const handleDialogClose = () => {
    setIsEditDialogOpen(false)
    setSelectedTeam(null)
  }

  const handleDialogSuccess = () => {
    fetchTeams()
  }

  const getDisplayName = (team: AdminPublicTeam): string => {
    return team.display_name || team.name
  }

  const getCollaborationMode = (json: Record<string, unknown>): string => {
    const spec = (json?.spec as Record<string, unknown>) || {}
    return (spec?.collaborationModel as string) || 'pipeline'
  }

  const getMemberCount = (json: Record<string, unknown>): number => {
    const spec = (json?.spec as Record<string, unknown>) || {}
    const members = (spec?.members as unknown[]) || []
    return members.length
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('public_teams.title')}</h2>
        <p className="text-sm text-text-muted">{t('public_teams.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && teams.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <UsersRound className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('public_teams.no_teams')}</p>
          </div>
        )}

        {/* Team List */}
        {!loading && teams.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {teams.map(team => (
              <Card
                key={team.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {getDisplayName(team)}
                        </h3>
                        <Tag variant="default">{getCollaborationMode(team.json)}</Tag>
                        {team.is_active ? (
                          <Tag variant="success">{t('public_teams.status.active')}</Tag>
                        ) : (
                          <Tag variant="error">{t('public_teams.status.inactive')}</Tag>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                        <span>
                          {t('public_teams.form.name')}: {team.name}
                        </span>
                        <span>*</span>
                        <span>
                          {t('public_teams.member_count', {
                            count: getMemberCount(team.json),
                          })}
                        </span>
                        {team.description && (
                          <>
                            <span>*</span>
                            <span className="truncate max-w-[200px]">{team.description}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(team)}
                      title={t('public_teams.edit_team')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedTeam(team)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('public_teams.delete_team')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={openCreateDialog}>
                {t('public_teams.create_team')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Team Dialog - Using the new component */}
      <PublicTeamEditDialog
        open={isEditDialogOpen}
        onClose={handleDialogClose}
        editingTeam={selectedTeam}
        onSuccess={handleDialogSuccess}
        toast={toast}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('public_teams.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('public_teams.confirm.delete_message', { name: selectedTeam?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteTeam} className="bg-error hover:bg-error/90">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default PublicTeamList
