// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback } from 'react'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import { Tag } from '@/components/ui/tag'
import {
  WrenchScrewdriverIcon,
  PencilIcon,
  TrashIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import ToolEditDialog from './ToolEditDialog'
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
import { toolApis, UnifiedTool } from '@/apis/tools'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

interface ToolListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>
  onEditResource?: (namespace: string) => void
}

const ToolList: React.FC<ToolListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
}) => {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [tools, setTools] = useState<UnifiedTool[]>([])
  const [loading, setLoading] = useState(true)
  const [editingTool, setEditingTool] = useState<UnifiedTool | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmTool, setDeleteConfirmTool] = useState<UnifiedTool | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const fetchTools = useCallback(async () => {
    setLoading(true)
    try {
      const response = await toolApis.getTools(scope, groupName)
      setTools(response.data || [])
    } catch (error) {
      console.error('Failed to fetch tools:', error)
      toast({
        variant: 'destructive',
        title: t('tools.errors.load_tools_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t, scope, groupName])

  useEffect(() => {
    fetchTools()
  }, [fetchTools, scope, groupName])

  // Categorize tools by type
  const { groupTools, publicTools, userTools } = React.useMemo(() => {
    const group: UnifiedTool[] = []
    const publicList: UnifiedTool[] = []
    const user: UnifiedTool[] = []

    for (const tool of tools) {
      if (tool.type === 'group') {
        group.push(tool)
      } else if (tool.type === 'public') {
        publicList.push(tool)
      } else {
        user.push(tool)
      }
    }

    return {
      groupTools: group,
      publicTools: publicList,
      userTools: user,
    }
  }, [tools])

  const totalTools = groupTools.length + publicTools.length + userTools.length

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

  const canCreateInAnyGroup =
    groupRoleMap &&
    Array.from(groupRoleMap.values()).some(role => role === 'Owner' || role === 'Maintainer')

  const handleDelete = async () => {
    if (!deleteConfirmTool) return

    setIsDeleting(true)
    try {
      await toolApis.deleteTool(deleteConfirmTool.name)
      toast({
        title: t('tools.delete_success'),
      })
      setDeleteConfirmTool(null)
      fetchTools()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleEdit = (tool: UnifiedTool) => {
    if (tool.type === 'public') return

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && tool.namespace && tool.namespace !== 'default') {
      onEditResource(tool.namespace)
    }

    setEditingTool(tool)
    setDialogOpen(true)
  }

  const handleEditClose = () => {
    setEditingTool(null)
    setDialogOpen(false)
    fetchTools()
  }

  const handleCreate = () => {
    setEditingTool(null)
    setDialogOpen(true)
  }

  const getToolTypeLabel = (toolType: string) => {
    if (toolType === 'builtin') return t('tools.type_builtin')
    if (toolType === 'mcp') return t('tools.type_mcp')
    return toolType
  }

  const getMcpServerTypeLabel = (mcpType?: string | null) => {
    if (!mcpType) return ''
    if (mcpType === 'stdio') return 'stdio'
    if (mcpType === 'sse') return 'SSE'
    if (mcpType === 'streamable-http') return 'HTTP'
    return mcpType
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('tools.title')}</h2>
        <p className="text-sm text-text-muted mb-1">{t('tools.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && totalTools === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <WrenchScrewdriverIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('tools.no_tools')}</p>
            <p className="text-sm text-text-muted mt-1">{t('tools.no_tools_hint')}</p>
          </div>
        )}

        {/* Tool List - Categorized */}
        {!loading && totalTools > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 p-1">
              {/* User Tools Section */}
              {userTools.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('tools.my_tools')} ({userTools.length})
                  </h3>
                  <div className="space-y-2">
                    {userTools.map(tool => (
                      <ResourceListItem
                        key={`user-${tool.name}`}
                        icon={WrenchScrewdriverIcon}
                        name={tool.displayName || tool.name}
                        description={tool.description}
                        tags={
                          <div className="flex gap-1 flex-wrap">
                            <Tag variant={tool.toolType === 'builtin' ? 'info' : 'success'} size="sm">
                              {getToolTypeLabel(tool.toolType)}
                            </Tag>
                            {tool.toolType === 'mcp' && tool.mcpServer && (
                              <Tag variant="default" size="sm">
                                {getMcpServerTypeLabel(tool.mcpServer.type)}
                              </Tag>
                            )}
                          </div>
                        }
                        actions={
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleEdit(tool)}
                              className="p-1.5 rounded-md hover:bg-hover text-text-secondary hover:text-text-primary"
                              title={t('common.edit')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setDeleteConfirmTool(tool)}
                              className="p-1.5 rounded-md hover:bg-hover text-text-secondary hover:text-error"
                              title={t('common.delete')}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </button>
                          </div>
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Group Tools Section */}
              {groupTools.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('tools.group_tools')} ({groupTools.length})
                  </h3>
                  <div className="space-y-2">
                    {groupTools.map(tool => {
                      const namespace = tool.namespace || 'default'
                      const canEdit = canEditGroupResource(namespace)
                      const canDelete = canDeleteGroupResource(namespace)

                      return (
                        <ResourceListItem
                          key={`group-${tool.namespace}-${tool.name}`}
                          icon={WrenchScrewdriverIcon}
                          name={tool.displayName || tool.name}
                          description={tool.description}
                          tags={
                            <div className="flex gap-1 flex-wrap">
                              <Tag variant="default" size="sm">
                                {tool.namespace}
                              </Tag>
                              <Tag variant={tool.toolType === 'builtin' ? 'info' : 'success'} size="sm">
                                {getToolTypeLabel(tool.toolType)}
                              </Tag>
                              {tool.toolType === 'mcp' && tool.mcpServer && (
                                <Tag variant="default" size="sm">
                                  {getMcpServerTypeLabel(tool.mcpServer.type)}
                                </Tag>
                              )}
                            </div>
                          }
                          actions={
                            <div className="flex items-center gap-1">
                              {canEdit && (
                                <button
                                  onClick={() => handleEdit(tool)}
                                  className="p-1.5 rounded-md hover:bg-hover text-text-secondary hover:text-text-primary"
                                  title={t('common.edit')}
                                >
                                  <PencilIcon className="w-4 h-4" />
                                </button>
                              )}
                              {canDelete && (
                                <button
                                  onClick={() => setDeleteConfirmTool(tool)}
                                  className="p-1.5 rounded-md hover:bg-hover text-text-secondary hover:text-error"
                                  title={t('common.delete')}
                                >
                                  <TrashIcon className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          }
                        />
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Public Tools Section */}
              {publicTools.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('tools.public_tools')} ({publicTools.length})
                  </h3>
                  <div className="space-y-2">
                    {publicTools.map(tool => (
                      <ResourceListItem
                        key={`public-${tool.name}`}
                        icon={WrenchScrewdriverIcon}
                        name={tool.displayName || tool.name}
                        description={tool.description}
                        publicBadge={
                          <Tag variant="info" size="sm" className="flex items-center gap-1">
                            <GlobeAltIcon className="w-3 h-3" />
                            {t('common.public')}
                          </Tag>
                        }
                        tags={
                          <div className="flex gap-1 flex-wrap">
                            <Tag variant={tool.toolType === 'builtin' ? 'info' : 'success'} size="sm">
                              {getToolTypeLabel(tool.toolType)}
                            </Tag>
                            {tool.toolType === 'mcp' && tool.mcpServer && (
                              <Tag variant="default" size="sm">
                                {getMcpServerTypeLabel(tool.mcpServer.type)}
                              </Tag>
                            )}
                          </div>
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer with Create Button */}
            <div className="mt-4 pt-4 border-t border-border flex justify-end px-2">
              <UnifiedAddButton
                label={t('tools.create_tool')}
                onClick={handleCreate}
                showGroupOption={scope === 'all' && canCreateInAnyGroup}
              />
            </div>
          </>
        )}

        {/* Empty list footer */}
        {!loading && totalTools === 0 && (
          <div className="mt-4 pt-4 border-t border-border flex justify-end px-2">
            <UnifiedAddButton
              label={t('tools.create_tool')}
              onClick={handleCreate}
              showGroupOption={scope === 'all' && canCreateInAnyGroup}
            />
          </div>
        )}
      </div>

      {/* Edit/Create Dialog */}
      <ToolEditDialog
        open={dialogOpen}
        onClose={handleEditClose}
        tool={editingTool}
        groupName={groupName}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmTool}
        onOpenChange={open => !open && setDeleteConfirmTool(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tools.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tools.delete_confirm_message', {
                toolName: deleteConfirmTool?.displayName || deleteConfirmTool?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-error hover:bg-error/90"
            >
              {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ToolList
