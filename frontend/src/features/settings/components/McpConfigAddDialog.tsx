// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react'

import type { MCPServer } from '@/apis/mcpProviders'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'

import { normalizeMcpServers, parseMcpConfig } from '../utils/mcpConfig'
import type { AgentType } from '../utils/mcpTypeAdapter'
import { McpProviderBrowser } from './McpProviderModal'

interface McpConfigAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onManualImport: (config: Record<string, unknown>) => void
  onProviderImport: (server: MCPServer) => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  agentType?: AgentType
}

export default function McpConfigAddDialog({
  open,
  onOpenChange,
  onManualImport,
  onProviderImport,
  toast,
  agentType,
}: McpConfigAddDialogProps) {
  const { t } = useTranslation('common')
  const [manualConfig, setManualConfig] = useState('')
  const [manualConfigError, setManualConfigError] = useState(false)

  const resetManualState = useCallback(() => {
    setManualConfig('')
    setManualConfigError(false)
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetManualState()
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetManualState]
  )

  const handleManualConfirm = useCallback(() => {
    const trimmed = manualConfig.trim()
    if (!trimmed) {
      setManualConfigError(true)
      toast({
        variant: 'destructive',
        title: t('bot.errors.mcp_config_json'),
      })
      return
    }

    try {
      const parsed = parseMcpConfig(trimmed)
      const normalized = normalizeMcpServers(parsed, agentType)
      onManualImport(normalized)
      resetManualState()
      onOpenChange(false)
    } catch (error) {
      setManualConfigError(true)
      if (error instanceof SyntaxError) {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_json'),
        })
      } else if (error instanceof Error && error.message === 'mcp_config_missing_server_name') {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_missing_server_name'),
        })
      } else if (error instanceof Error && error.message.startsWith('mcp_server_name_invalid:')) {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_server_name_invalid'),
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_invalid'),
        })
      }
    }
  }, [agentType, manualConfig, onManualImport, onOpenChange, resetManualState, toast, t])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-5xl h-[700px] p-0 overflow-hidden bg-background flex flex-col">
        <DialogHeader className="px-5 py-4 border-b bg-muted/20 shrink-0">
          <DialogTitle>{t('bot.mcp_add_dialog_title')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="provider" className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-5 py-3">
            <TabsList>
              <TabsTrigger value="provider">{t('bot.mcp_add_provider_tab')}</TabsTrigger>
              <TabsTrigger value="manual">{t('bot.mcp_add_manual_tab')}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="provider" className="m-0 min-h-0 flex-1">
            <McpProviderBrowser onImportServer={onProviderImport} />
          </TabsContent>
          <TabsContent value="manual" className="m-0 flex min-h-0 flex-1 flex-col px-5 py-4">
            <div className="mb-3 text-sm text-text-secondary">{t('bot.import_mcp_desc')}</div>
            <Textarea
              value={manualConfig}
              onChange={event => {
                setManualConfig(event.target.value)
                setManualConfigError(false)
              }}
              placeholder={`{
  "mcpServers": {
    "remote-server": {
      "url": "http://127.0.0.1:9099/sse"
    }
  }
}`}
              className={manualConfigError ? 'min-h-0 flex-1 border-red-500' : 'min-h-0 flex-1'}
              data-testid="mcp-manual-config-textarea"
            />
            {manualConfigError && (
              <div className="mt-1 text-sm text-red-500">{t('bot.errors.mcp_config_json')}</div>
            )}
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleManualConfirm}>
                {t('bot.add_mcp_json')}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
