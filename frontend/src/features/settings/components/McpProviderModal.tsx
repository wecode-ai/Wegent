// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Plus,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Settings,
  Key,
  Server,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { mcpProviderApis, MCPProvider, MCPServer } from '@/apis/mcpProviders'

interface McpProviderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportServer: (server: MCPServer) => void
}

const McpProviderModal: React.FC<McpProviderModalProps> = ({
  open,
  onOpenChange,
  onImportServer,
}) => {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [providers, setProviders] = useState<MCPProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<MCPProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [servers, setServers] = useState<MCPServer[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set())
  const [showSettings, setShowSettings] = useState(false)

  // Load providers on mount
  useEffect(() => {
    if (open) {
      loadProviders()
    }
  }, [open])

  // Auto-sync servers when provider changes
  useEffect(() => {
    if (selectedProvider) {
      setApiKey('')
      // Only show settings for providers that require token and don't have one
      setShowSettings(selectedProvider.requires_token && !selectedProvider.has_token)
      // Auto sync servers if provider doesn't require token or already has token
      if (!selectedProvider.requires_token || selectedProvider.has_token) {
        syncServers()
      } else {
        setServers([])
      }
    }
  }, [selectedProvider])

  const loadProviders = async () => {
    try {
      setLoading(true)
      const response = await mcpProviderApis.getProviders()
      if (response?.providers && Array.isArray(response.providers)) {
        setProviders(response.providers)
        if (response.providers.length > 0 && !selectedProvider) {
          setSelectedProvider(response.providers[0])
        }
      }
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('mcpProviders.errors.load_providers_failed'),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSaveApiKey = async () => {
    if (!selectedProvider || !apiKey.trim()) return

    try {
      setSaving(true)
      const data: Record<string, string | undefined> = {}
      data[selectedProvider.token_field_name] = apiKey.trim()

      await mcpProviderApis.updateKeys(data)
      toast({
        title: t('mcpProviders.api_key_saved'),
      })

      // Refresh providers to update has_token status
      await loadProviders()
      setShowSettings(false)

      // Auto sync servers after saving API key
      await syncServers()
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('mcpProviders.errors.save_api_key_failed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const syncServers = async () => {
    if (!selectedProvider) return

    try {
      setSyncing(true)
      const response = await mcpProviderApis.syncServers(selectedProvider.key)
      if (response.success) {
        setServers(response.servers)
        if (response.servers.length === 0) {
          toast({
            title: t('mcpProviders.no_servers_found'),
          })
        }
      } else {
        toast({
          variant: 'destructive',
          title: response.message || t('mcpProviders.errors.sync_failed'),
        })
      }
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('mcpProviders.errors.sync_failed'),
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleAddServer = useCallback(
    (server: MCPServer) => {
      onImportServer(server)
      setAddedServers(prev => new Set(prev).add(server.id))
      toast({
        title: t('mcpProviders.server_added', { name: server.name }),
      })
    },
    [onImportServer, toast, t]
  )

  const handleOpenApiKeyUrl = () => {
    if (selectedProvider?.api_key_url) {
      window.open(selectedProvider.api_key_url, '_blank')
    }
  }

  const handleOpenDiscoverUrl = () => {
    if (selectedProvider?.discover_url) {
      window.open(selectedProvider.discover_url, '_blank')
    }
  }

  const hasServers = servers.length > 0
  const isLoadingServers = syncing && servers.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[700px] p-0 overflow-hidden bg-background">
        <DialogHeader className="px-5 py-4 border-b bg-muted/20 shrink-0">
          <DialogTitle className="text-lg font-semibold flex items-center gap-2">
            <Server className="w-5 h-5 text-primary" />
            {t('mcpProviders.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex h-[calc(700px-72px)]">
          {/* Left sidebar - Provider list */}
          <div className="w-40 border-r bg-muted/10 shrink-0">
            <ScrollArea className="h-full">
              <div className="p-2 space-y-1">
                {providers.map(provider => (
                  <button
                    key={provider.key}
                    onClick={() => setSelectedProvider(provider)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
                      selectedProvider?.key === provider.key
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <div className="font-medium truncate">{provider.name}</div>
                    {provider.has_token && (
                      <div className="text-xs opacity-75 mt-0.5 flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        {t('mcpProviders.configured')}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedProvider ? (
              <>
                {/* Header with settings toggle */}
                <div className="px-4 py-2.5 border-b bg-muted/5 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{t('mcpProviders.mcp_servers')}</span>
                    {hasServers && (
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                        {servers.length}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => syncServers()}
                      disabled={
                        syncing || (selectedProvider.requires_token && !selectedProvider.has_token)
                      }
                      className="h-8 text-xs gap-1.5 cursor-pointer hover:bg-muted"
                    >
                      {syncing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      {t('mcpProviders.refresh')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSettings(!showSettings)}
                      className={`h-8 text-xs gap-1.5 cursor-pointer ${
                        showSettings ? 'bg-muted' : 'hover:bg-muted'
                      }`}
                    >
                      <Settings className="w-3.5 h-3.5" />
                      {showSettings ? (
                        <>
                          {t('mcpProviders.hide_settings')}
                          <ChevronUp className="w-3.5 h-3.5" />
                        </>
                      ) : (
                        <>
                          {t('mcpProviders.settings')}
                          <ChevronDown className="w-3.5 h-3.5" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Collapsible Settings Panel */}
                {showSettings && (
                  <div className="px-4 py-3 border-b bg-muted/5 shrink-0">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Key className="w-4 h-4 text-muted-foreground" />
                        <Label className="text-sm font-medium">{t('mcpProviders.api_key')}</Label>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleOpenApiKeyUrl}
                          className="h-7 text-xs gap-1 cursor-pointer hover:bg-muted"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {t('mcpProviders.get_api_key')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleOpenDiscoverUrl}
                          className="h-7 text-xs gap-1 cursor-pointer hover:bg-muted"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {t('mcpProviders.discover')}
                        </Button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="api-key"
                        type="password"
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                        placeholder={t('mcpProviders.api_key_placeholder')}
                        className="flex-1 h-9"
                      />
                      <Button
                        onClick={handleSaveApiKey}
                        disabled={!apiKey.trim() || saving}
                        size="sm"
                        className="gap-1.5 h-9 cursor-pointer"
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Check className="w-4 h-4" />
                            {t('mcpProviders.save')}
                          </>
                        )}
                      </Button>
                    </div>
                    {selectedProvider.has_token && (
                      <div className="text-xs text-muted-foreground mt-2">
                        {t('mcpProviders.has_token_hint')}
                      </div>
                    )}
                  </div>
                )}

                {/* Servers list - main content area */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-3">
                      {isLoadingServers ? (
                        <div className="flex flex-col items-center justify-center py-20">
                          <Loader2 className="w-10 h-10 animate-spin mb-4 text-primary" />
                          <p className="text-sm text-muted-foreground">
                            {t('mcpProviders.loading_servers')}
                          </p>
                        </div>
                      ) : !hasServers ? (
                        <div className="flex flex-col items-center justify-center py-20">
                          <Server className="w-14 h-14 mb-4 text-muted-foreground/30" />
                          <p className="text-sm text-muted-foreground mb-2">
                            {t('mcpProviders.no_servers_hint')}
                          </p>
                          {selectedProvider.requires_token && !selectedProvider.has_token && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setShowSettings(true)}
                              className="gap-1.5 cursor-pointer"
                            >
                              <Key className="w-4 h-4" />
                              {t('mcpProviders.configure_api_key')}
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          {servers.map(server => {
                            const isAdded = addedServers.has(server.id)
                            return (
                              <div
                                key={server.id}
                                className="flex items-center justify-between p-3 rounded-lg border bg-background hover:bg-muted/50 transition-colors cursor-pointer group"
                              >
                                <div className="flex-1 min-w-0 mr-3">
                                  <div className="font-medium text-sm truncate group-hover:text-primary transition-colors">
                                    {server.name}
                                  </div>
                                  {server.description && (
                                    <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                      {server.description}
                                    </div>
                                  )}
                                  <div className="text-xs text-muted-foreground/70 mt-1 truncate font-mono">
                                    {server.base_url}
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant={isAdded ? 'secondary' : 'default'}
                                  onClick={() => handleAddServer(server)}
                                  disabled={isAdded}
                                  className={`gap-1.5 h-8 ${
                                    isAdded ? 'cursor-default' : 'cursor-pointer'
                                  }`}
                                >
                                  {isAdded ? (
                                    <>
                                      <Check className="w-3.5 h-3.5" />
                                      <span>{t('mcpProviders.added')}</span>
                                    </>
                                  ) : (
                                    <>
                                      <Plus className="w-3.5 h-3.5" />
                                      <span>{t('mcpProviders.add')}</span>
                                    </>
                                  )}
                                </Button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {loading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  t('mcpProviders.select_provider')
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default McpProviderModal
