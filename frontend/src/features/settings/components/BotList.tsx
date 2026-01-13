// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import { useCallback, useEffect, useState } from 'react'
import { PencilIcon, TrashIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import LoadingState from '@/features/common/LoadingState'
import { Bot } from '@/types/api'
import {
  fetchBotsList,
  deleteBot,
  isPredefinedModel,
  getModelFromConfig,
  checkBotRunningTasks,
} from '../services/bots'
import { CheckRunningTasksResponse } from '@/apis/common'
import BotEdit from './BotEdit'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { useTranslation } from '@/hooks/useTranslation'
import { sortBotsByUpdatedAt } from '@/utils/bot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
interface BotListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>
}

export default function BotList({ scope = 'personal', groupName, groupRoleMap }: BotListProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [cloningBot, setCloningBot] = useState<Bot | null>(null)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [forceDeleteConfirmVisible, setForceDeleteConfirmVisible] = useState(false)
  const [botToDelete, setBotToDelete] = useState<number | null>(null)
  const [runningTasksInfo, setRunningTasksInfo] = useState<CheckRunningTasksResponse | null>(null)
  const [isCheckingTasks, setIsCheckingTasks] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const isEditing = editingBotId !== null

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>(
    updater => {
      setBots(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Bot[]) => Bot[])(prev) : updater
        return sortBotsByUpdatedAt(next)
      })
    },
    [setBots]
  )

  useEffect(() => {
    async function loadBots() {
      setIsLoading(true)
      try {
        const botsData = await fetchBotsList(scope, groupName)
        setBotsSorted(botsData)
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bots.loading'),
        })
      } finally {
        setIsLoading(false)
      }
    }
    loadBots()
  }, [toast, setBotsSorted, t, scope, groupName])

  const handleCreateBot = () => {
    // Validation for group scope: must have groupName
    if (scope === 'group' && !groupName) {
      toast({
        variant: 'destructive',
        title: t('common:bots.group_required_title'),
        description: t('common:bots.group_required_message'),
      })
      return
    }

    setCloningBot(null)
    setEditingBotId(0) // Use 0 to mark new creation
  }

  const handleEditBot = (bot: Bot) => {
    setCloningBot(null)
    setEditingBotId(bot.id)
  }

  const handleCloneBot = (bot: Bot) => {
    setCloningBot(bot)
    setEditingBotId(0)
  }

  const handleCloseEditor = () => {
    setEditingBotId(null)
    setCloningBot(null)
  }

  const handleDeleteBot = async (botId: number) => {
    setBotToDelete(botId)
    setIsCheckingTasks(true)

    try {
      // Check if bot has running tasks
      const result = await checkBotRunningTasks(botId)
      setRunningTasksInfo(result)

      if (result.has_running_tasks) {
        // Show force delete confirmation dialog
        setForceDeleteConfirmVisible(true)
      } else {
        // Show normal delete confirmation dialog
        setDeleteConfirmVisible(true)
      }
    } catch (e) {
      // If check fails, show normal delete dialog
      console.error('Failed to check running tasks:', e)
      setDeleteConfirmVisible(true)
    } finally {
      setIsCheckingTasks(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!botToDelete) return

    setIsDeleting(true)
    try {
      await deleteBot(botToDelete)
      setBotsSorted(prev => prev.filter(b => b.id !== botToDelete))
      setDeleteConfirmVisible(false)
      setBotToDelete(null)
      setRunningTasksInfo(null)
    } catch (e) {
      const errorMessage = e instanceof Error && e.message ? e.message : t('common:bots.delete')
      toast({
        variant: 'destructive',
        title: errorMessage,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleForceDelete = async () => {
    if (!botToDelete) return

    setIsDeleting(true)
    try {
      await deleteBot(botToDelete, true)
      setBotsSorted(prev => prev.filter(b => b.id !== botToDelete))
      setForceDeleteConfirmVisible(false)
      setBotToDelete(null)
      setRunningTasksInfo(null)
    } catch (e) {
      const errorMessage = e instanceof Error && e.message ? e.message : t('common:bots.delete')
      toast({
        variant: 'destructive',
        title: errorMessage,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false)
    setForceDeleteConfirmVisible(false)
    setBotToDelete(null)
    setRunningTasksInfo(null)
  }

  // Helper function to check if a bot is a group resource
  const isGroupBot = (bot: Bot) => {
    return bot.namespace && bot.namespace !== 'default'
  }

  // Helper function to check permissions for a specific group resource
  const canEditGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
  }

  const canDeleteGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer'
  }

  // Check if user can create in the current group context
  // When scope is 'group', check the specific groupName; only Owner/Maintainer can create
  const canCreateInCurrentGroup = (() => {
    if (scope !== 'group' || !groupName || !groupRoleMap) return false
    const role = groupRoleMap.get(groupName)
    return role === 'Owner' || role === 'Maintainer'
  })()

  // Check if edit button should be shown
  const shouldShowEdit = (bot: Bot) => {
    // For group bots, check group permissions
    if (isGroupBot(bot)) {
      return canEditGroupResource(bot.namespace!)
    }
    // For personal bots, always show
    return true
  }

  // Check if delete button should be shown
  const shouldShowDelete = (bot: Bot) => {
    // For group bots, check group permissions
    if (isGroupBot(bot)) {
      return canDeleteGroupResource(bot.namespace!)
    }
    // For personal bots, always show
    return true
  }

  // Check if copy button should be shown (same permission as create)
  const shouldShowCopy = (bot: Bot) => {
    // For group bots, check group permissions (need create permission)
    if (isGroupBot(bot)) {
      return canDeleteGroupResource(bot.namespace!) // Maintainer/Owner can create
    }
    // For personal bots, always show
    return true
  }

  return (
    <>
      <div className="space-y-3">
        <div
          className={`bg-base border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'md:min-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
              : 'max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
          }`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('common:bots.loading')} />
          ) : (
            <>
              {/* Edit/New mode */}
              {isEditing ? (
                <BotEdit
                  bots={bots}
                  setBots={setBotsSorted}
                  editingBotId={editingBotId}
                  cloningBot={cloningBot}
                  onClose={handleCloseEditor}
                  toast={toast}
                  scope={scope}
                  groupName={groupName}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
                    {bots.length > 0 ? (
                      bots.map(bot => (
                        <Card key={bot.id} className="p-4 bg-base hover:bg-hover transition-colors">
                          <div className="flex items-center justify-between min-w-0">
                            <ResourceListItem
                              name={bot.name}
                              icon={<RiRobot2Line className="w-5 h-5 text-primary" />}
                              tags={[
                                {
                                  key: 'shell-type',
                                  label: bot.shell_type,
                                  variant: 'default',
                                  className: 'capitalize',
                                },
                                {
                                  key: 'model',
                                  label: isPredefinedModel(bot.agent_config)
                                    ? getModelFromConfig(bot.agent_config)
                                    : 'CustomModel',
                                  variant: 'info',
                                  className: 'hidden sm:inline-flex capitalize',
                                },
                              ]}
                            >
                              <div className="flex items-center space-x-1 flex-shrink-0">
                                <div
                                  className="w-2 h-2 rounded-full"
                                  style={{
                                    backgroundColor: bot.is_active
                                      ? 'rgb(var(--color-success))'
                                      : 'rgb(var(--color-border))',
                                  }}
                                ></div>
                                <span className="text-xs text-text-muted">
                                  {bot.is_active
                                    ? t('common:bots.active')
                                    : t('common:bots.inactive')}
                                </span>
                              </div>
                            </ResourceListItem>
                            <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                              {shouldShowEdit(bot) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleEditBot(bot)}
                                  title={t('common:bots.edit')}
                                  className="h-8 w-8"
                                >
                                  <PencilIcon className="w-4 h-4" />
                                </Button>
                              )}
                              {shouldShowCopy(bot) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleCloneBot(bot)}
                                  title={t('common:bots.copy')}
                                  className="h-8 w-8"
                                >
                                  <DocumentDuplicateIcon className="w-4 h-4" />
                                </Button>
                              )}
                              {shouldShowDelete(bot) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDeleteBot(bot?.id)}
                                  disabled={isCheckingTasks}
                                  title={t('common:bots.delete')}
                                  className="h-8 w-8 hover:text-error"
                                >
                                  <TrashIcon className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      ))
                    ) : (
                      <div className="text-center text-text-muted py-8">
                        <p className="text-sm">{t('common:bots.no_bots')}</p>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border pt-3 mt-3 bg-base">
                    <div className="flex justify-center">
                      {(scope === 'personal' || canCreateInCurrentGroup) && (
                        <UnifiedAddButton onClick={handleCreateBot}>
                          {t('common:bots.new_bot')}
                        </UnifiedAddButton>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmVisible(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:bots.delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('common:bots.delete_confirm_message')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete} disabled={isDeleting}>
              {t('common:common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('common:actions.deleting')}
                </div>
              ) : (
                t('common:common.confirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Force delete confirmation dialog for running tasks */}
      <Dialog
        open={forceDeleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setForceDeleteConfirmVisible(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:bots.force_delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              <div className="space-y-3">
                <p>
                  {t('common:bots.force_delete_confirm_message', {
                    count: runningTasksInfo?.running_tasks_count || 0,
                  })}
                </p>
                {runningTasksInfo && runningTasksInfo.running_tasks.length > 0 && (
                  <div className="bg-muted p-3 rounded-md">
                    <p className="font-medium text-sm mb-2">
                      {t('common:bots.running_tasks_list')}
                    </p>
                    <ul className="text-sm space-y-1">
                      {runningTasksInfo.running_tasks.slice(0, 5).map(task => (
                        <li key={task.task_id} className="text-text-muted">
                          • {task.task_title || task.task_name} ({task.status})
                        </li>
                      ))}
                      {runningTasksInfo.running_tasks.length > 5 && (
                        <li className="text-text-muted">
                          ...{' '}
                          {t('common:bots.and_more_tasks', {
                            count: runningTasksInfo.running_tasks.length - 5,
                          })}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-error text-sm">{t('common:bots.force_delete_warning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete} disabled={isDeleting}>
              {t('common:common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleForceDelete} disabled={isDeleting}>
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('common:actions.deleting')}
                </div>
              ) : (
                t('common:bots.force_delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
