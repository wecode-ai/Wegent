// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { PlusIcon, SettingsIcon, XIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  parseMcpConfig,
  stringifyMcpConfig,
  removeMcpServer,
  mergeMcpConfigs,
} from '../utils/mcpConfig'
import { adaptMcpConfigForAgent, type AgentType } from '../utils/mcpTypeAdapter'
import McpConfigAddDialog from './McpConfigAddDialog'
import McpConfigImportModal from './McpConfigImportModal'
import McpConfigEditModal from './McpConfigEditModal'
import McpProviderModal from './McpProviderModal'
import SingleMcpServerEditModal from './SingleMcpServerEditModal'

interface McpConfigSectionProps {
  mcpConfig: string
  onMcpConfigChange: (config: string) => void
  agentType?: AgentType
  readOnly?: boolean
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  hideHeaderLabel?: boolean
  compact?: boolean
}

const McpConfigSection: React.FC<McpConfigSectionProps> = ({
  mcpConfig,
  onMcpConfigChange,
  agentType,
  readOnly = false,
  toast,
  hideHeaderLabel = false,
  compact = false,
}) => {
  const { t } = useTranslation('common')

  const [mcpEditModalOpen, setMcpEditModalOpen] = useState(false)
  const [singleMcpEditOpen, setSingleMcpEditOpen] = useState(false)
  const [editingMcpServerName, setEditingMcpServerName] = useState<string | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [importModalVisible, setImportModalVisible] = useState(false)
  const [providerModalOpen, setProviderModalOpen] = useState(false)

  const mcpConfigState = useMemo(() => {
    try {
      return {
        config: parseMcpConfig(mcpConfig),
        parseError: false,
      }
    } catch {
      return {
        config: {} as Record<string, unknown>,
        parseError: true,
      }
    }
  }, [mcpConfig])

  const mcpServerNames = useMemo(() => Object.keys(mcpConfigState.config), [mcpConfigState.config])

  const handleOpenMcpEditModal = useCallback(() => {
    if (readOnly) return
    setMcpEditModalOpen(true)
  }, [readOnly])

  const handleOpenSingleMcpEdit = useCallback(
    (serverName: string) => {
      if (readOnly) return
      setEditingMcpServerName(serverName)
      setSingleMcpEditOpen(true)
    },
    [readOnly]
  )

  const handleSingleMcpEditSave = useCallback(
    (serverConfig: Record<string, unknown>) => {
      if (!editingMcpServerName) return
      try {
        const currentConfig = parseMcpConfig(mcpConfig)
        const newConfig = {
          ...currentConfig,
          [editingMcpServerName]: serverConfig,
        }
        onMcpConfigChange(stringifyMcpConfig(newConfig))
        setSingleMcpEditOpen(false)
        setEditingMcpServerName(null)
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      }
    },
    [editingMcpServerName, mcpConfig, onMcpConfigChange, toast, t]
  )

  const handleOpenMcpAddDialog = useCallback(() => {
    if (readOnly) return
    setAddDialogOpen(true)
  }, [readOnly])

  const handleOpenMcpImportModal = useCallback(() => {
    if (readOnly) return
    setImportModalVisible(true)
  }, [readOnly])

  const handleDeleteMcpServer = useCallback(
    (serverName: string) => {
      if (readOnly) return
      try {
        const currentConfig = parseMcpConfig(mcpConfig)
        const nextConfig = removeMcpServer(currentConfig, serverName)
        onMcpConfigChange(stringifyMcpConfig(nextConfig))
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      }
    },
    [mcpConfig, readOnly, onMcpConfigChange, toast, t]
  )

  const handleManualAddConfirm = useCallback(
    (config: Record<string, unknown>) => {
      try {
        const currentConfig = parseMcpConfig(mcpConfig)
        const mergedConfig = mergeMcpConfigs(currentConfig, config)
        onMcpConfigChange(stringifyMcpConfig(mergedConfig))
        toast({
          title: t('common:bot.append_success'),
        })
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      }
    },
    [mcpConfig, onMcpConfigChange, toast, t]
  )

  const handleImportConfirm = useCallback(
    (config: Record<string, unknown>, mode: 'replace' | 'append') => {
      try {
        if (mode === 'replace') {
          onMcpConfigChange(stringifyMcpConfig(config))
          toast({
            title: t('common:bot.import_success'),
          })
        } else {
          const currentConfig = parseMcpConfig(mcpConfig)
          const mergedConfig = mergeMcpConfigs(currentConfig, config)
          onMcpConfigChange(stringifyMcpConfig(mergedConfig))
          toast({
            title: t('common:bot.append_success'),
          })
        }
        setImportModalVisible(false)
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      }
    },
    [mcpConfig, onMcpConfigChange, toast, t]
  )

  const handleMcpEditSave = useCallback(
    (config: Record<string, unknown>) => {
      let adaptedConfig = config
      if (agentType) {
        adaptedConfig = adaptMcpConfigForAgent(config, agentType)
      }
      onMcpConfigChange(stringifyMcpConfig(adaptedConfig))
    },
    [onMcpConfigChange, agentType]
  )

  const handleImportServerFromProvider = useCallback(
    (server: {
      id: string
      name: string
      description?: string
      type: string
      base_url?: string
      headers?: Record<string, string>
    }) => {
      try {
        const currentConfig = parseMcpConfig(mcpConfig)
        const serverKey = server.id.replace(/[@\/]/g, '_')

        const newServer: Record<string, unknown> = {
          type: server.type === 'streamableHttp' ? 'streamable-http' : server.type,
        }

        if (server.base_url) {
          newServer.url = server.base_url
        }

        if (server.headers && Object.keys(server.headers).length > 0) {
          newServer.headers = server.headers
        }

        const mergedConfig = mergeMcpConfigs(currentConfig, {
          [serverKey]: newServer,
        })
        onMcpConfigChange(stringifyMcpConfig(mergedConfig))
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
      }
    },
    [mcpConfig, onMcpConfigChange, toast, t]
  )

  // Type label mapping
  const typeLabel: Record<string, string> = {
    'streamable-http': 'HTTP',
    http: 'HTTP',
    sse: 'SSE',
    stdio: 'STDIO',
  }

  const renderAddButton = () => (
    <Button
      size="sm"
      variant="ghost"
      onClick={handleOpenMcpAddDialog}
      disabled={readOnly}
      className="h-8 w-8 p-0 text-text-muted hover:text-text-primary disabled:cursor-not-allowed"
      data-testid="add-mcp-config-button"
      aria-label={t('common:bot.add_mcp_json')}
    >
      <PlusIcon className="h-4 w-4 opacity-50" />
    </Button>
  )

  const renderEmptyTrigger = (message: string, messageClassName?: string) => (
    <button
      type="button"
      onClick={handleOpenMcpAddDialog}
      disabled={readOnly}
      className="flex h-9 w-full items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="mcp-config-actions"
      aria-label={t('common:bot.add_mcp_json')}
    >
      <span className={messageClassName || 'truncate text-text-muted'}>{message}</span>
      <PlusIcon className="h-4 w-4 shrink-0 text-text-muted opacity-50" />
    </button>
  )

  if (!compact) {
    return (
      <div className="flex flex-col flex-grow">
        {/* Header */}
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {!hideHeaderLabel && (
              <label className="block text-base font-medium leading-8 text-text-primary">
                {t('common:bot.mcp_config')}
              </label>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenMcpEditModal}
              disabled={readOnly}
              className="h-8 text-xs disabled:cursor-not-allowed"
            >
              {t('common:bot.edit_mcp_json')}
            </Button>
            <span className="text-text-muted text-xs">|</span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenMcpImportModal}
              disabled={readOnly}
              className="h-8 text-xs disabled:cursor-not-allowed"
            >
              {t('common:bot.add_mcp_json')}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setProviderModalOpen(true)}
              disabled={readOnly}
              className="text-xs gap-1.5 disabled:cursor-not-allowed"
            >
              {t('common:mcpProviders.provider_button')}
            </Button>
          </div>
        </div>

        {/* Server List */}
        <div className="flex-grow overflow-hidden rounded-md border border-border bg-base p-2 min-h-[120px]">
          {mcpConfigState.parseError ? (
            <div className="px-4 py-3 text-sm text-red-500">
              {t('common:bot.errors.mcp_config_json')}
            </div>
          ) : mcpServerNames.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <span className="text-sm text-text-muted mb-2">{t('common:bot.no_mcp_servers')}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenMcpImportModal}
                disabled={readOnly}
                className="text-xs"
              >
                {t('common:bot.add_mcp_json')}
              </Button>
            </div>
          ) : (
            <div className="max-h-44 overflow-y-auto custom-scrollbar space-y-1">
              {mcpServerNames.map(serverName => {
                const serverConfig = mcpConfigState.config[serverName] as
                  | Record<string, unknown>
                  | undefined
                const serverType = (serverConfig?.type as string) || ''
                const serverUrl =
                  (serverConfig?.url as string) || (serverConfig?.base_url as string) || ''

                return (
                  <div
                    key={serverName}
                    className="group flex items-center justify-between px-3 py-2 border border-border rounded-md hover:border-primary/30 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">
                          {serverName}
                        </span>
                        {serverType && (
                          <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-text-muted shrink-0">
                            {typeLabel[serverType] || serverType}
                          </span>
                        )}
                      </div>
                      {(serverType === 'sse' ||
                        serverType === 'streamable-http' ||
                        serverType === 'http') &&
                        serverUrl && (
                          <div className="text-xs text-text-muted truncate mt-0.5">{serverUrl}</div>
                        )}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleOpenSingleMcpEdit(serverName)}
                        disabled={readOnly}
                        className="h-7 w-7 p-0 text-text-muted hover:text-text-primary"
                      >
                        <SettingsIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteMcpServer(serverName)}
                        disabled={readOnly}
                        className="h-7 w-7 p-0 text-text-muted hover:text-red-500"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Modals */}
        <McpConfigEditModal
          open={mcpEditModalOpen}
          onOpenChange={setMcpEditModalOpen}
          initialConfig={mcpConfig}
          onSave={handleMcpEditSave}
          toast={toast}
          agentType={agentType}
        />

        <McpConfigImportModal
          visible={importModalVisible}
          onClose={() => setImportModalVisible(false)}
          onImport={handleImportConfirm}
          toast={toast}
          agentType={agentType}
          mode="append-only"
        />

        <McpProviderModal
          open={providerModalOpen}
          onOpenChange={setProviderModalOpen}
          onImportServer={handleImportServerFromProvider}
        />

        {editingMcpServerName && (
          <SingleMcpServerEditModal
            open={singleMcpEditOpen}
            onOpenChange={setSingleMcpEditOpen}
            serverName={editingMcpServerName}
            serverConfig={mcpConfigState.config[editingMcpServerName] as Record<string, unknown>}
            onSave={handleSingleMcpEditSave}
            onClose={() => {
              setSingleMcpEditOpen(false)
              setEditingMcpServerName(null)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-grow">
      {/* Header */}
      {!hideHeaderLabel && (
        <div className="mb-1 flex items-center">
          <div className="flex items-center gap-1.5">
            <label className="block text-base font-medium leading-8 text-text-primary">
              {t('common:bot.mcp_config')}
            </label>
          </div>
        </div>
      )}

      {/* Server List */}
      <div
        className={
          compact
            ? ''
            : 'flex-grow overflow-hidden rounded-md border border-border bg-base p-2 min-h-[120px]'
        }
      >
        {mcpConfigState.parseError ? (
          renderEmptyTrigger(t('common:bot.errors.mcp_config_json'), 'truncate text-red-500')
        ) : compact && mcpServerNames.length === 0 ? (
          renderEmptyTrigger(t('common:bot.no_mcp_servers'))
        ) : mcpServerNames.length === 0 ? (
          <div className="flex items-center justify-between gap-2 px-3 py-3">
            <span className="truncate text-sm text-text-muted">
              {t('common:bot.no_mcp_servers')}
            </span>
            {renderAddButton()}
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <div
              className={
                compact
                  ? 'max-h-32 min-w-0 flex-1 space-y-1 overflow-y-auto p-1 custom-scrollbar'
                  : 'max-h-44 min-w-0 flex-1 overflow-y-auto custom-scrollbar space-y-1'
              }
            >
              {mcpServerNames.map(serverName => {
                const serverConfig = mcpConfigState.config[serverName] as
                  | Record<string, unknown>
                  | undefined
                const serverType = (serverConfig?.type as string) || ''
                const serverUrl =
                  (serverConfig?.url as string) || (serverConfig?.base_url as string) || ''

                return (
                  <div
                    key={serverName}
                    className="group flex items-center justify-between px-3 py-2 border border-border rounded-md hover:border-primary/30 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">
                          {serverName}
                        </span>
                        {serverType && (
                          <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-text-muted shrink-0">
                            {typeLabel[serverType] || serverType}
                          </span>
                        )}
                      </div>
                      {(serverType === 'sse' ||
                        serverType === 'streamable-http' ||
                        serverType === 'http') &&
                        serverUrl && (
                          <div className="text-xs text-text-muted truncate mt-0.5">{serverUrl}</div>
                        )}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleOpenSingleMcpEdit(serverName)}
                        disabled={readOnly}
                        className="h-7 w-7 p-0 text-text-muted hover:text-text-primary"
                      >
                        <SettingsIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteMcpServer(serverName)}
                        disabled={readOnly}
                        className="h-7 w-7 p-0 text-text-muted hover:text-red-500"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="pt-1 pr-1">{renderAddButton()}</div>
          </div>
        )}
      </div>

      {/* Modals */}
      <McpConfigAddDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onManualImport={handleManualAddConfirm}
        onProviderImport={handleImportServerFromProvider}
        toast={toast}
        agentType={agentType}
      />

      {editingMcpServerName && (
        <SingleMcpServerEditModal
          open={singleMcpEditOpen}
          onOpenChange={setSingleMcpEditOpen}
          serverName={editingMcpServerName}
          serverConfig={mcpConfigState.config[editingMcpServerName] as Record<string, unknown>}
          onSave={handleSingleMcpEditSave}
          onClose={() => {
            setSingleMcpEditOpen(false)
            setEditingMcpServerName(null)
          }}
        />
      )}
    </div>
  )
}

export default McpConfigSection
