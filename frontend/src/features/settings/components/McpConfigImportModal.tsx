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
import { useTranslation } from '@/hooks/useTranslation'
import type { AgentType } from '../utils/mcpTypeAdapter'
import { normalizeMcpServers, parseMcpConfig } from '../utils/mcpConfig'

interface McpConfigImportModalProps {
  visible: boolean
  onClose: () => void
  onImport: (config: Record<string, unknown>, mode: 'replace' | 'append') => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  agentType?: AgentType
  mode?: 'full' | 'append-only'
}

const McpConfigImportModal: React.FC<McpConfigImportModalProps> = ({
  visible,
  onClose,
  onImport,
  toast,
  agentType,
  mode = 'full',
}) => {
  const { t } = useTranslation('common')
  const [importConfig, setImportConfig] = useState('')
  const [importConfigError, setImportConfigError] = useState(false)
  const [importMode, setImportMode] = useState<'replace' | 'append'>('replace')
  const appendOnly = mode === 'append-only'

  // Handle import configuration confirmation
  const handleImportConfirm = useCallback(() => {
    const trimmed = importConfig.trim()
    if (!trimmed) {
      setImportConfigError(true)
      toast({
        variant: 'destructive',
        title: t('bot.errors.mcp_config_json'),
      })
      return
    }

    try {
      // Parse the imported configuration
      const parsed = parseMcpConfig(trimmed)
      // Normalize the MCP servers configuration with agent type adaptation
      const normalized = normalizeMcpServers(parsed, agentType)
      const selectedMode = appendOnly ? 'append' : importMode

      // Call parent component's import handler function
      onImport(normalized, selectedMode)

      // Reset state
      setImportConfig('')
      setImportConfigError(false)
    } catch (error) {
      setImportConfigError(true)
      if (error instanceof SyntaxError) {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_json'),
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('bot.errors.mcp_config_invalid'),
        })
      }
    }
  }, [importConfig, importMode, toast, onImport, t, agentType, appendOnly])

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
          <DialogTitle>{t('bot.import_mcp_title')}</DialogTitle>
        </DialogHeader>
        <div className="mb-2">
          <p>{t('bot.import_mcp_desc')}</p>
          {!appendOnly && (
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
                  <label htmlFor="replace-mode">{t('bot.import_mode_replace')}</label>
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
                  <label htmlFor="append-mode">{t('bot.import_mode_append')}</label>
                </div>
              </div>
            </div>
          )}
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
          <div className="text-red-500 mt-1">{t('bot.errors.mcp_config_json')}</div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleImportConfirm}>
            {t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default McpConfigImportModal
