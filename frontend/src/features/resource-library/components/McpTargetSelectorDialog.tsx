// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Bot as BotIcon, Check, Loader2, Package, Search, X } from 'lucide-react'

import { botApis } from '@/apis/bots'
import type { MCPServer } from '@/apis/mcpProviders'
import { teamApis } from '@/apis/team'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Bot, Team } from '@/types/api'
import { mergeMcpConfigs } from '@/features/settings/utils/mcpConfig'
import {
  adaptMcpConfigForShell,
  isMcpCapableShellType,
} from '@/features/settings/utils/mcpTypeAdapter'
import { buildProviderMcpConfig } from '@/features/settings/utils/providerMcpConfig'
import { ResourceIcon } from './ResourceIcon'

interface McpTargetSelectorDialogProps {
  server: MCPServer | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function McpTargetSelectorDialog({
  server,
  open,
  onOpenChange,
}: McpTargetSelectorDialogProps) {
  const { t } = useTranslation('resource-library')
  const { t: tCommon } = useTranslation('common')
  const { toast } = useToast()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selectedBotIds, setSelectedBotIds] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (!open) return

    let active = true
    setLoading(true)
    setLoadFailed(false)
    setSearchQuery('')
    setSelectedBotIds(new Set())

    Promise.all([
      teamApis.getTeams({ page: 1, limit: 100 }, 'personal'),
      botApis.getBots({ page: 1, limit: 100 }, 'personal'),
    ])
      .then(([teamResponse, botResponse]) => {
        if (!active) return
        setTeams(teamResponse.items.filter(team => team.is_active))
        setBots(
          botResponse.items.filter(bot => bot.is_active && isMcpCapableShellType(bot.shell_type))
        )
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [open])

  const botById = useMemo(() => new Map(bots.map(bot => [bot.id, bot])), [bots])
  const assignedBotIds = useMemo(
    () => new Set(teams.flatMap(team => team.bots.map(teamBot => teamBot.bot_id))),
    [teams]
  )
  const standaloneBots = bots.filter(bot => !assignedBotIds.has(bot.id))
  const hasTargets =
    standaloneBots.length > 0 ||
    teams.some(team => team.bots.some(teamBot => botById.has(teamBot.bot_id)))
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const matchesSearch = (...values: Array<string | null | undefined>) =>
    !normalizedQuery || values.some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
  const filteredTeams = teams
    .map(team => {
      const teamBots = team.bots
        .map(teamBot => botById.get(teamBot.bot_id))
        .filter((bot): bot is Bot => Boolean(bot))
      const teamMatches = matchesSearch(team.displayName, team.name, team.description)
      return {
        team,
        bots: teamMatches
          ? teamBots
          : teamBots.filter(bot => matchesSearch(bot.name, bot.shell_name, bot.shell_type)),
      }
    })
    .filter(item => item.bots.length > 0)
  const filteredStandaloneBots = standaloneBots.filter(bot =>
    matchesSearch(bot.name, bot.shell_name, bot.shell_type)
  )
  const hasSearchResults = filteredTeams.length > 0 || filteredStandaloneBots.length > 0

  const handleOpenChange = (nextOpen: boolean) => {
    if (saving) return

    if (!nextOpen) {
      setSelectedBotIds(new Set())
      setSearchQuery('')
    }
    onOpenChange(nextOpen)
  }

  const toggleBot = (botId: number) => {
    if (saving) return

    setSelectedBotIds(current => {
      const next = new Set(current)
      if (next.has(botId)) {
        next.delete(botId)
      } else {
        next.add(botId)
      }
      return next
    })
  }

  const bindSelectedBots = async () => {
    if (!server || selectedBotIds.size === 0 || saving) return

    const selectedBots = [...selectedBotIds]
      .map(botId => botById.get(botId))
      .filter((bot): bot is Bot => Boolean(bot))
    if (selectedBots.length === 0) return

    setSaving(true)
    const results = await Promise.allSettled(
      selectedBots.map(async bot => {
        if (!isMcpCapableShellType(bot.shell_type)) {
          throw new Error(`Unsupported MCP shell type: ${bot.shell_type}`)
        }
        let mcpServers = mergeMcpConfigs(bot.mcp_servers || {}, buildProviderMcpConfig(server))
        mcpServers = adaptMcpConfigForShell(mcpServers, bot.shell_type)
        await botApis.updateBot(bot.id, { mcp_servers: mcpServers })
      })
    )
    const failedBots = selectedBots.filter((_, index) => results[index].status === 'rejected')
    const successCount = selectedBots.length - failedBots.length

    if (failedBots.length === 0) {
      toast({
        title: t('mcp_market.bind_success'),
        description: t('mcp_market.bind_batch_success_message', {
          mcp: server.name,
          count: successCount,
        }),
      })
      setSaving(false)
      setSelectedBotIds(new Set())
      onOpenChange(false)
      return
    }

    setSelectedBotIds(new Set(failedBots.map(bot => bot.id)))
    setSaving(false)
    toast({
      variant: 'destructive',
      title: t('mcp_market.bind_partial_failed'),
      description: t('mcp_market.bind_partial_failed_message', {
        success: successCount,
        failed: failedBots.length,
      }),
    })
  }

  const renderBotButton = (bot: Bot, teamId?: number) => {
    const selected = selectedBotIds.has(bot.id)

    return (
      <Button
        key={`${teamId || 'standalone'}:${bot.id}`}
        type="button"
        variant="secondary"
        role="checkbox"
        aria-checked={selected}
        className={cn(
          'group/bot h-11 w-full justify-start gap-2.5 rounded-lg px-3 text-left',
          selected
            ? 'border-primary bg-primary/[0.12] text-primary ring-1 ring-primary/20 hover:bg-primary/[0.16]'
            : 'border-primary/[0.15] bg-primary/[0.06] text-primary hover:border-primary/25 hover:bg-primary/[0.12]'
        )}
        onClick={() => toggleBot(bot.id)}
        disabled={saving}
        data-testid={
          teamId ? `mcp-target-team-${teamId}-bot-${bot.id}` : `mcp-target-bot-${bot.id}`
        }
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
            selected
              ? 'border-primary bg-primary text-white'
              : 'border-text-muted/60 bg-base group-hover/bot:border-primary'
          )}
          data-testid={`mcp-target-checkbox-${bot.id}`}
          data-state={selected ? 'checked' : 'unchecked'}
          aria-hidden
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <BotIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{bot.name}</span>
            <span className="block truncate text-[11px] font-normal text-text-muted">
              {bot.shell_name}
            </span>
          </span>
        </span>
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[84vh] max-w-6xl overflow-hidden"
        preventEscapeClose={saving}
        preventOutsideClick={saving}
      >
        <DialogHeader>
          <DialogTitle>{t('mcp_market.choose_target')}</DialogTitle>
          <DialogDescription>
            {t('mcp_market.choose_target_description', { name: server?.name || '' })}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={t('mcp_market.target_search_placeholder')}
            className="h-11 rounded-xl border-border bg-base pl-9 pr-11"
            data-testid="mcp-target-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-text-muted hover:bg-muted hover:text-text-primary"
              onClick={() => setSearchQuery('')}
              aria-label={t('actions.clear_search')}
              data-testid="mcp-target-search-clear"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        <ScrollArea className="max-h-[58vh] pr-3">
          {loading ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-text-muted">
              <Loader2 className="mb-2 h-7 w-7 animate-spin" aria-hidden />
              <p>{t('mcp_market.loading_targets')}</p>
            </div>
          ) : loadFailed ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-text-muted">
              <Package className="mb-3 h-10 w-10 opacity-50" aria-hidden />
              <p>{t('mcp_market.targets_load_failed')}</p>
            </div>
          ) : !hasTargets ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-text-muted">
              <Package className="mb-3 h-10 w-10 opacity-50" aria-hidden />
              <p>{t('mcp_market.no_targets')}</p>
            </div>
          ) : !hasSearchResults ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-text-muted">
              <Search className="mb-3 h-10 w-10 opacity-40" aria-hidden />
              <p>{t('mcp_market.no_target_results')}</p>
            </div>
          ) : (
            <div
              className="grid gap-3 py-1 md:grid-cols-2 lg:grid-cols-3"
              data-testid="mcp-target-list"
            >
              {filteredTeams.map(({ team, bots: teamBots }) => {
                return (
                  <Card
                    key={team.id}
                    className="group flex min-h-[148px] flex-col gap-3 rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
                    data-testid={`mcp-target-agent-card-${team.id}`}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <ResourceIcon
                        resourceType="agent"
                        name={team.displayName || team.name}
                        icon={team.icon}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-base font-semibold text-text-primary">
                          {team.displayName || team.name}
                        </h3>
                        <Badge variant="secondary" size="sm" className="mt-1">
                          {tCommon('teams.bot_count', { count: teamBots.length })}
                        </Badge>
                      </div>
                    </div>

                    {team.description && (
                      <p className="line-clamp-2 text-sm leading-5 text-text-secondary">
                        {team.description}
                      </p>
                    )}

                    <div className="mt-auto space-y-2 pt-1">
                      {teamBots.length > 1 && (
                        <p className="text-xs font-medium text-text-muted">
                          {t('mcp_market.choose_bot')}
                        </p>
                      )}
                      {teamBots.map(bot => renderBotButton(bot, team.id))}
                    </div>
                  </Card>
                )
              })}

              {filteredStandaloneBots.map(bot => (
                <Card
                  key={`standalone:${bot.id}`}
                  className="group flex min-h-[148px] flex-col gap-3 rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
                  data-testid={`mcp-target-standalone-card-${bot.id}`}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <ResourceIcon resourceType="agent" name={bot.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-semibold text-text-primary">
                        {bot.name}
                      </h3>
                      <Badge variant="secondary" size="sm" className="mt-1">
                        {t('mcp_market.other_bots')}
                      </Badge>
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
                    {t('mcp_market.standalone_bot_description')}
                  </p>
                  <div className="mt-auto pt-1">{renderBotButton(bot)}</div>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>

        {!loading && !loadFailed && hasTargets && (
          <DialogFooter className="border-t border-border pt-4 sm:items-center sm:justify-between">
            <span className="text-sm text-text-secondary" data-testid="mcp-target-selected-count">
              {t('mcp_market.selected_bot_count', { count: selectedBotIds.size })}
            </span>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {tCommon('actions.cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void bindSelectedBots()}
                disabled={selectedBotIds.size === 0 || saving}
                data-testid="mcp-target-submit"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t('mcp_market.add_to_selected_bots', { count: selectedBotIds.size })}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
