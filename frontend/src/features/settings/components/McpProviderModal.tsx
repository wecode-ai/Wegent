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
import { Plus, Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
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

  // Load providers on mount
  useEffect(() => {
    if (open) {
      loadProviders()
    }
  }, [open])

  // Reset state when provider changes and auto-sync if has token
  useEffect(() => {
    if (selectedProvider) {
      setApiKey('')
      setServers([])
      setAddedServers(new Set())
      // Auto sync servers if provider already has token
      if (selectedProvider.has_token) {
        syncServers()
      }
    }
  }, [selectedProvider])

  const loadProviders = async () => {
    try {
      setLoading(true)
      console.log('[McpProviderModal] Loading providers...')
      const response = await mcpProviderApis.getProviders()
      console.log('[McpProviderModal] Response:', response)
      console.log('[McpProviderModal] Response.providers:', response?.providers)
      if (response?.providers && Array.isArray(response.providers)) {
        setProviders(response.providers)
        if (response.providers.length > 0) {
          setSelectedProvider(response.providers[0])
        }
      } else {
        console.error('[McpProviderModal] Invalid response format:', response)
        throw new Error('Invalid response format')
      }
    } catch (error) {
      console.error('[McpProviderModal] Error loading providers:', error)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[600px] p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>{t('mcpProviders.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex h-[calc(600px-80px)]">
          {/* Left sidebar - Provider list */}
          <div className="w-48 border-r bg-muted/30">
            <ScrollArea className="h-full">
              <div className="p-2">
                {providers.map(provider => (
                  <button
                    key={provider.key}
                    onClick={() => setSelectedProvider(provider)}
                    className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                      selectedProvider?.key === provider.key
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <div className="font-medium">{provider.name}</div>
                    {provider.has_token && (
                      <div className="text-xs opacity-70 mt-0.5">
                        {t('mcpProviders.configured')}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col">
            {selectedProvider ? (
              <>
                {/* API Key section */}
                <div className="p-4 border-b space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="api-key" className="text-sm font-medium">
                      {t('mcpProviders.api_key')}
                    </Label>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenApiKeyUrl}
                        className="h-7 text-xs gap-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {t('mcpProviders.get_api_key')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenDiscoverUrl}
                        className="h-7 text-xs gap-1"
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
                      className="flex-1"
                    />
                    <Button
                      onClick={handleSaveApiKey}
                      disabled={!apiKey.trim() || saving}
                      className="gap-1"
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
                    <div className="text-xs text-muted-foreground">
                      {t('mcpProviders.has_token_hint')}
                    </div>
                  )}
                </div>

                {/* Servers list */}
                <div className="flex-1 overflow-hidden">
                  <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between">
                    <span className="text-sm font-medium">{t('mcpProviders.mcp_servers')}</span>
                    <div className="flex items-center gap-2">
                      {selectedProvider?.has_token && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => syncServers()}
                          disabled={syncing}
                          className="h-7 text-xs gap-1"
                        >
                          {syncing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3" />
                          )}
                          {t('mcpProviders.refresh')}
                        </Button>
                      )}
                      {syncing && (
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  </div>
                  <ScrollArea className="h-[calc(100%-40px)]">
                    <div className="p-2 space-y-2">
                      {servers.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground text-sm">
                          {syncing
                            ? t('mcpProviders.loading_servers')
                            : t('mcpProviders.no_servers_hint')}
                        </div>
                      ) : (
                        servers.map(server => {
                          const isAdded = addedServers.has(server.id)
                          return (
                            <div
                              key={server.id}
                              className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm truncate">{server.name}</div>
                                {server.description && (
                                  <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                    {server.description}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground mt-1">
                                  {server.base_url}
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant={isAdded ? 'ghost' : 'outline'}
                                onClick={() => handleAddServer(server)}
                                disabled={isAdded}
                                className="ml-2 gap-1"
                              >
                                {isAdded ? (
                                  <>
                                    <Check className="w-3.5 h-3.5" />
                                    {t('mcpProviders.added')}
                                  </>
                                ) : (
                                  <>
                                    <Plus className="w-3.5 h-3.5" />
                                    {t('mcpProviders.add')}
                                  </>
                                )}
                              </Button>
                            </div>
                          )
                        })
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
