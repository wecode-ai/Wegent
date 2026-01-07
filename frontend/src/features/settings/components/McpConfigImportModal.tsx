// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from 'react-i18next'
import { adaptMcpConfigForAgent, type AgentType } from '../utils/mcpTypeAdapter'

interface McpConfigImportModalProps {
  visible: boolean
  onClose: () => void
  onImport: (config: Record<string, unknown>, mode: 'replace' | 'append') => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  agentType?: AgentType
}

// Utility function to normalize MCP servers configuration
function normalizeMcpServers(
  config: Record<string, unknown>,
  agentType?: AgentType
): Record<string, unknown> {
  const servers: Record<string, unknown> = (config.mcpServers ??
    config.mcp_servers ??
    config) as Record<string, unknown>
  if (typeof servers !== 'object' || servers === null) {
    throw new Error('Invalid MCP servers configuration')
  }

  Object.keys(servers).forEach(key => {
    const server = servers[key] as Record<string, unknown>
    if (server.transport) {
      server.type = server.transport
      delete server.transport
    }
    if (!server.type) {
      server.type = 'stdio'
    }
  })

  // Apply type adaptation if agent type is specified
  if (agentType) {
    return adaptMcpConfigForAgent(servers, agentType)
  }

  return servers
}

const McpConfigImportModal: React.FC<McpConfigImportModalProps> = ({
  visible,
  onClose,
  onImport,
  toast,
  agentType,
}) => {
  const { t } = useTranslation()
  const [importConfig, setImportConfig] = useState('')
  const [importConfigError, setImportConfigError] = useState(false)
  const [importMode, setImportMode] = useState<'replace' | 'append'>('replace')

  // Handle import configuration confirmation
  const handleImportConfirm = useCallback(() => {
    const trimmed = importConfig.trim()
    if (!trimmed) {
      setImportConfigError(true)
      toast({
        variant: 'destructive',
        title: t('common:bot.errors.mcp_config_json'),
      })
      return
    }

    try {
      // Parse the imported configuration
      const parsed = JSON.parse(trimmed)
      // Normalize the MCP servers configuration with agent type adaptation
      const normalized = normalizeMcpServers(parsed, agentType)

      // Call parent component's import handler function
      onImport(normalized, importMode)

      // Reset state
      setImportConfig('')
      setImportConfigError(false)
    } catch (error) {
      setImportConfigError(true)
      if (error instanceof SyntaxError) {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_invalid'),
        })
      }
    }
  }, [importConfig, importMode, toast, onImport, t, agentType])

  // Reset state when closing modal
  const handleCancel = () => {
    setImportConfig('')
    setImportConfigError(false)
    onClose()
  }

  return (
    <Dialog open={visible} onOpenChange={open => !open && handleCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('common:bot.import_mcp_title')}</DialogTitle>
        </DialogHeader>
        <div className="mb-2">
          <p>{t('common:bot.import_mcp_desc')}</p>
          <div className="mt-2 mb-3">
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <input
                  type="radio"
                  id="replace-mode"
                  name="import-mode"
                  value="replace"
                  checked={importMode === 'replace'}
                  onChange={() => setImportMode('replace')}
                  className="mr-2"
                />
                <label htmlFor="replace-mode">{t('common:bot.import_mode_replace')}</label>
              </div>
              <div className="flex items-center">
                <input
                  type="radio"
                  id="append-mode"
                  name="import-mode"
                  value="append"
                  checked={importMode === 'append'}
                  onChange={() => setImportMode('append')}
                  className="mr-2"
                />
                <label htmlFor="append-mode">{t('common:bot.import_mode_append')}</label>
              </div>
            </div>
          </div>
        </div>
        <Textarea
          value={importConfig}
          onChange={e => {
            setImportConfig(e.target.value)
            setImportConfigError(false)
          }}
          placeholder={`{
    "mcpServers": {
      "remote-server": {
        "url": "http://127.0.0.1:9099/sse"
      },
      "weibo-search-mcp": {
        "transport": "streamable_http"
      },
      "EcoMCP-server": {
        "url": "http://example.com:9999/sse",
        "disabled": false,
        "alwaysAllow": []
      }
    }
  }`}
          rows={10}
          className={importConfigError ? 'border-red-500' : ''}
        />
        {importConfigError && (
          <div className="text-red-500 mt-1">{t('common:bot.errors.mcp_config_json')}</div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleImportConfirm}>{t('common:actions.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default McpConfigImportModal
