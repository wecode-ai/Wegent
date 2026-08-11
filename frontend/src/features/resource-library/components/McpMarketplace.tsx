// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, Package, Search } from 'lucide-react'

import { mcpProviderApis, type MCPProvider, type MCPServer } from '@/apis/mcpProviders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { McpMarketplaceCard } from './McpMarketplaceCard'
import { McpTargetSelectorDialog } from './McpTargetSelectorDialog'

function matchesKeyword(server: MCPServer, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase()
  if (!normalizedKeyword) return true

  return [server.name, server.description, server.provider, ...(server.tags || [])]
    .filter(Boolean)
    .some(value => value?.toLocaleLowerCase().includes(normalizedKeyword))
}

export function McpMarketplace() {
  const { t } = useTranslation('resource-library')
  const [providers, setProviders] = useState<MCPProvider[]>([])
  const [activeProviderKey, setActiveProviderKey] = useState('')
  const [servers, setServers] = useState<MCPServer[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedServer, setSelectedServer] = useState<MCPServer | null>(null)

  const loadServers = useCallback(
    async (providerKey: string) => {
      setLoading(true)
      setError('')
      setServers([])

      try {
        const response = await mcpProviderApis.syncServers(providerKey)
        if (!response.success) throw new Error(response.message)
        setServers(response.servers.filter(server => server.is_active))
      } catch (loadError) {
        const message =
          loadError instanceof Error ? loadError.message : t('mcp_market.unknown_error')
        setError(message)
      } finally {
        setLoading(false)
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
    if (activeProviderKey) void loadServers(activeProviderKey)
  }, [activeProviderKey, loadServers])

  const filteredServers = useMemo(
    () => servers.filter(server => matchesKeyword(server, keyword)),
    [keyword, servers]
  )
  const activeProvider = providers.find(provider => provider.key === activeProviderKey)

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

      {loading ? (
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
