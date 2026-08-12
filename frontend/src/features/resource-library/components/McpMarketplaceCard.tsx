// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Plus } from 'lucide-react'

import type { MCPServer } from '@/apis/mcpProviders'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { ResourceIcon } from './ResourceIcon'

interface McpMarketplaceCardProps {
  server: MCPServer
  onAdd: (server: MCPServer) => void
}

export function McpMarketplaceCard({ server, onAdd }: McpMarketplaceCardProps) {
  const { t } = useTranslation('resource-library')
  const actionLabel = t('mcp_market.add_to_agent')

  return (
    <Card
      className="group relative flex h-full flex-col gap-3 overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
      data-testid={`mcp-marketplace-card-${server.id}`}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3 z-10 h-11 w-11 border-primary/20 bg-primary/[0.04] px-0 text-primary shadow-sm hover:border-primary/40 hover:bg-primary/[0.1] hover:shadow-md md:h-8 md:w-8"
        onClick={() => onAdd(server)}
        aria-label={`${actionLabel} ${server.name}`}
        title={actionLabel}
        data-testid={`add-market-mcp-${server.id}`}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </Button>

      <div className="flex min-w-0 items-start gap-3 pr-12">
        <ResourceIcon
          resourceType="mcp"
          name={server.name}
          icon={server.logo_url}
          marketplaceTags={server.tags}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text-primary">{server.name}</h3>
          <p className="mt-0.5 truncate text-xs text-text-muted">{server.provider}</p>
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {server.description || server.name}
      </p>

      {server.tags && server.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {server.tags.slice(0, 3).map(tag => (
            <Badge key={tag} variant="secondary" size="sm">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  )
}
