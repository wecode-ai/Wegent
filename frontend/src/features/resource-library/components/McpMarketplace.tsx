// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, KeyRound, Loader2, Package, Search } from 'lucide-react'

import { mcpProviderApis, type MCPProvider, type MCPServer } from '@/apis/mcpProviders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import { matchesMcpServerKeyword } from '../mcpMarketplace'
import { McpMarketplaceCard } from './McpMarketplaceCard'
import { McpTargetSelectorDialog } from './McpTargetSelectorDialog'

export function McpMarketplace() {
  const { t } = useTranslation('resource-library')
  const [providers, setProviders] = useState<MCPProvider[]>([])
  const [activeProviderKey, setActiveProviderKey] = useState('')
  const [servers, setServers] = useState<MCPServer[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyError, setApiKeyError] = useState('')
  const [savingApiKey, setSavingApiKey] = useState(false)
  const [selectedServer, setSelectedServer] = useState<MCPServer | null>(null)
  const serverRequestId = useRef(0)

  const loadServers = useCallback(
    async (providerKey: string) => {
      const requestId = ++serverRequestId.current
      setLoading(true)
      setError('')
      setServers([])

      try {
        const response = await mcpProviderApis.syncServers(providerKey)
        if (requestId !== serverRequestId.current) return
        if (!response.success) throw new Error(response.message)
        setServers(response.servers.filter(server => server.is_active))
      } catch (loadError) {
        if (requestId !== serverRequestId.current) return
        const message =
          loadError instanceof Error ? loadError.message : t('mcp_market.unknown_error')
        setError(message)
      } finally {
        if (requestId === serverRequestId.current) setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    let active = true

    mcpProviderApis
      .getProviders()
      .then(response => {
        if (!active) return
        setProviders(response.providers)
        const firstProvider = response.providers[0]
        if (!firstProvider) {
          setLoading(false)
          return
        }
        setActiveProviderKey(firstProvider.key)
      })
      .catch(loadError => {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : t('mcp_market.unknown_error'))
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [t])

  useEffect(() => {
    const provider = providers.find(item => item.key === activeProviderKey)
    if (!provider) return

    setApiKey('')
    setApiKeyError('')
    if (provider.requires_token && !provider.has_token) {
      serverRequestId.current += 1
      setServers([])
      setLoading(false)
      setError('')
      return
    }

    void loadServers(activeProviderKey)
  }, [activeProviderKey, loadServers, providers])

  const filteredServers = useMemo(
    () => servers.filter(server => matchesMcpServerKeyword(server, keyword)),
    [keyword, servers]
  )
  const activeProvider = providers.find(provider => provider.key === activeProviderKey)
  const needsApiKey = Boolean(activeProvider?.requires_token && !activeProvider.has_token)

  const handleSaveApiKey = async () => {
    if (!activeProvider || !apiKey.trim()) return

    setSavingApiKey(true)
    setApiKeyError('')
    try {
      const response = await mcpProviderApis.updateKeys({
        [activeProvider.token_field_name]: apiKey.trim(),
      })
      if (!response.success) throw new Error(response.message)

      setProviders(current =>
        current.map(provider =>
          provider.key === activeProvider.key ? { ...provider, has_token: true } : provider
        )
      )
      setApiKey('')
    } catch (saveError) {
      setApiKeyError(
        saveError instanceof Error ? saveError.message : t('mcp_market.api_key_save_failed')
      )
    } finally {
      setSavingApiKey(false)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="mcp-marketplace">
      {providers.length > 1 && (
        <div
          className="flex max-w-full gap-2 overflow-x-auto"
          role="tablist"
          aria-label={t('mcp_market.sources')}
          data-testid="mcp-marketplace-providers"
        >
          {providers.map(provider => (
            <Button
              key={provider.key}
              type="button"
              size="sm"
              variant={provider.key === activeProviderKey ? 'primary' : 'outline'}
              role="tab"
              aria-selected={provider.key === activeProviderKey}
              onClick={() => {
                serverRequestId.current += 1
                setKeyword('')
                setActiveProviderKey(provider.key)
              }}
              className="min-h-11 min-w-11 shrink-0 md:min-h-9 md:min-w-0"
              data-testid={`mcp-marketplace-provider-${provider.key}`}
            >
              {provider.name}
            </Button>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <Input
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder={t('mcp_market.search_placeholder')}
              className="h-11 bg-base pl-9 sm:h-10"
              data-testid="mcp-marketplace-search-input"
            />
          </div>
          {activeProvider?.discover_url && (
            <Button
              asChild
              variant="outline"
              className="h-11 shrink-0 px-4 sm:h-10"
              data-testid={`mcp-marketplace-open-${activeProvider.key}`}
            >
              <a href={activeProvider.discover_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t('mcp_market.open_market')}
              </a>
            </Button>
          )}
        </div>
      </div>

      {needsApiKey && activeProvider ? (
        <div
          className="flex min-h-[300px] flex-col items-center justify-center px-4 text-center"
          data-testid="mcp-marketplace-api-key-required"
        >
          <KeyRound className="mb-4 h-12 w-12 text-text-muted" aria-hidden />
          <h3 className="text-base font-medium text-text-primary">
            {t('mcp_market.api_key_required_title', { provider: activeProvider.name })}
          </h3>
          <p className="mt-2 max-w-lg text-sm text-text-secondary">
            {t('mcp_market.api_key_required_description', {
              provider: activeProvider.name,
            })}
          </p>
          <div className="mt-5 w-full max-w-md text-left">
            <Label htmlFor="mcp-marketplace-api-key">{t('mcp_market.api_key_label')}</Label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                id="mcp-marketplace-api-key"
                type="password"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={t('mcp_market.api_key_placeholder')}
                className="h-11 flex-1 sm:h-10"
                data-testid="mcp-marketplace-api-key-input"
              />
              <Button
                type="button"
                variant="primary"
                disabled={!apiKey.trim() || savingApiKey}
                onClick={() => void handleSaveApiKey()}
                className="h-11 shrink-0 sm:h-10"
                data-testid="mcp-marketplace-save-api-key"
              >
                {savingApiKey && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t('mcp_market.save_api_key')}
              </Button>
            </div>
            {apiKeyError && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {apiKeyError}
              </p>
            )}
          </div>
          {activeProvider.api_key_url && (
            <Button
              asChild
              variant="link"
              className="mt-3"
              data-testid={`mcp-marketplace-get-api-key-${activeProvider.key}`}
            >
              <a href={activeProvider.api_key_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t('mcp_market.get_api_key', { provider: activeProvider.name })}
              </a>
            </Button>
          )}
        </div>
      ) : loading ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center text-text-muted">
          <Loader2 className="mb-2 h-8 w-8 animate-spin" aria-hidden />
          <p>{t('mcp_market.loading')}</p>
        </div>
      ) : error ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center text-center text-text-muted">
          <Package className="mb-4 h-12 w-12 opacity-50" aria-hidden />
          <p>{t('mcp_market.load_failed')}</p>
          <p className="mt-1 max-w-xl text-xs">{error}</p>
        </div>
      ) : filteredServers.length === 0 ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center text-text-muted">
          <Package className="mb-4 h-12 w-12 opacity-50" aria-hidden />
          <p>{keyword.trim() ? t('mcp_market.no_results') : t('mcp_market.empty')}</p>
        </div>
      ) : (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          data-testid="mcp-marketplace-grid"
        >
          {filteredServers.map(server => (
            <McpMarketplaceCard key={server.id} server={server} onAdd={setSelectedServer} />
          ))}
        </div>
      )}

      <McpTargetSelectorDialog
        server={selectedServer}
        open={Boolean(selectedServer)}
        onOpenChange={open => {
          if (!open) setSelectedServer(null)
        }}
      />
    </div>
  )
}
