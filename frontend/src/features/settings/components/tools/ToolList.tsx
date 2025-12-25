// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  PlusIcon,
  TrashIcon,
  SettingsIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  PowerOffIcon,
  ServerIcon,
  WrenchIcon,
} from 'lucide-react'
import { getGhostTools, addToolToGhost, removeToolFromGhost, updateToolStatusInGhost } from '@/apis/tools'
import ToolMarketDialog from './ToolMarketDialog'
import ToolConfigDialog from './ToolConfigDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { GhostToolDetail, ToolMarketItem, ToolStatus } from '@/types/tool'

interface ToolListProps {
  ghostId: number
  onChange?: () => void
}

export default function ToolList({ ghostId, onChange }: ToolListProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [tools, setTools] = useState<GhostToolDetail[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [marketDialogOpen, setMarketDialogOpen] = useState(false)
  const [configDialogOpen, setConfigDialogOpen] = useState(false)
  const [selectedTool, setSelectedTool] = useState<GhostToolDetail | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [toolToDelete, setToolToDelete] = useState<GhostToolDetail | null>(null)

  const loadTools = useCallback(async () => {
    if (!ghostId) return

    setIsLoading(true)
    try {
      const toolsData = await getGhostTools(ghostId)
      setTools(toolsData)
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
      loadTools()
    }
  }, [ghostId, loadTools])

  const handleAddTool = async (tool: ToolMarketItem) => {
    try {
      await addToolToGhost(ghostId, tool.name)
      toast({
        title: t('common.success'),
        description: t('tools.tool_added', { toolName: tool.name }),
      })
      await loadTools()
      onChange?.()
      setMarketDialogOpen(false)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_add'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    }
  }

  const handleRemoveTool = async () => {
    if (!toolToDelete) return

    try {
      await removeToolFromGhost(ghostId, toolToDelete.tool_name)
      toast({
        title: t('common.success'),
        description: t('tools.tool_removed', { toolName: toolToDelete.tool_name }),
      })
      await loadTools()
      onChange?.()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_remove'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setDeleteDialogOpen(false)
      setToolToDelete(null)
    }
  }

  const handleToggleStatus = async (tool: GhostToolDetail) => {
    const newStatus: ToolStatus =
      tool.status === 'disabled' ? 'available' : 'disabled'

    try {
      await updateToolStatusInGhost(ghostId, tool.tool_name, newStatus)
      await loadTools()
      onChange?.()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_update'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    }
  }

  const handleConfigureTool = (tool: GhostToolDetail) => {
    setSelectedTool(tool)
    setConfigDialogOpen(true)
  }

  const handleConfigSaved = () => {
    loadTools()
    onChange?.()
  }

  const getStatusIcon = (status: ToolStatus) => {
    switch (status) {
      case 'available':
        return <CheckCircleIcon className="h-4 w-4 text-green-500" />
      case 'pending_config':
        return <AlertCircleIcon className="h-4 w-4 text-amber-500" />
      case 'disabled':
        return <PowerOffIcon className="h-4 w-4 text-text-secondary" />
    }
  }

  const getStatusLabel = (status: ToolStatus) => {
    switch (status) {
      case 'available':
        return t('tools.status_available')
      case 'pending_config':
        return t('tools.status_pending_config')
      case 'disabled':
        return t('tools.status_disabled')
    }
  }

  const getToolIcon = (type?: string) => {
    return type === 'mcp' ? (
      <ServerIcon className="h-4 w-4 text-primary" />
    ) : (
      <WrenchIcon className="h-4 w-4 text-primary" />
    )
  }

  const selectedToolNames = tools.map((t) => t.tool_name)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-text-primary">{t('tools.tools_title')}</h4>
        <Button variant="outline" size="sm" onClick={() => setMarketDialogOpen(true)}>
          <PlusIcon className="h-4 w-4 mr-1" />
          {t('tools.add_tool')}
        </Button>
      </div>

      {/* Tool List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        </div>
      ) : tools.length === 0 ? (
        <Card className="p-4 text-center text-text-secondary">
          <p className="text-sm">{t('tools.no_tools_added')}</p>
          <p className="text-xs mt-1">{t('tools.no_tools_hint')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {tools.map((tool) => (
            <Card
              key={tool.tool_name}
              className={`p-3 ${tool.status === 'disabled' ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {getToolIcon(tool.tool?.type)}
                  <span className="font-medium text-sm truncate">{tool.tool_name}</span>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>{getStatusIcon(tool.status)}</TooltipTrigger>
                      <TooltipContent>{getStatusLabel(tool.status)}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {tool.tool?.category && (
                    <Tag variant="secondary" size="sm">
                      {t(`tools.category_${tool.tool.category}`, tool.tool.category)}
                    </Tag>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {tool.has_secrets && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleConfigureTool(tool)}
                          >
                            <SettingsIcon className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('tools.configure')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => handleToggleStatus(tool)}
                        >
                          <PowerOffIcon
                            className={`h-4 w-4 ${
                              tool.status === 'disabled' ? 'text-text-secondary' : 'text-green-500'
                            }`}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {tool.status === 'disabled'
                          ? t('tools.enable')
                          : t('tools.disable')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => {
                            setToolToDelete(tool)
                            setDeleteDialogOpen(true)
                          }}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.delete')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
              {tool.tool?.description && (
                <p className="text-xs text-text-secondary mt-1 line-clamp-1">
                  {tool.tool.description}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Tool Market Dialog */}
      <ToolMarketDialog
        open={marketDialogOpen}
        onClose={() => setMarketDialogOpen(false)}
        onSelectTool={handleAddTool}
        selectedToolNames={selectedToolNames}
      />

      {/* Tool Config Dialog */}
      <ToolConfigDialog
        open={configDialogOpen}
        onClose={() => {
          setConfigDialogOpen(false)
          setSelectedTool(null)
        }}
        ghostId={ghostId}
        tool={selectedTool}
        onSaved={handleConfigSaved}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tools.confirm_remove')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tools.confirm_remove_description', {
                toolName: toolToDelete?.tool_name || '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveTool}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
