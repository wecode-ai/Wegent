// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'

import { teamApis } from '@/apis/team'
import type { Bot, Team } from '@/types/api'

function isBotDefinition(value: unknown): value is Bot {
  if (!value || typeof value !== 'object') return false
  const bot = value as Partial<Bot>
  return (
    typeof bot.id === 'number' &&
    typeof bot.name === 'string' &&
    typeof bot.shell_name === 'string' &&
    typeof bot.shell_type === 'string' &&
    typeof bot.system_prompt === 'string' &&
    typeof bot.agent_config === 'object' &&
    bot.agent_config !== null &&
    typeof bot.mcp_servers === 'object' &&
    bot.mcp_servers !== null &&
    typeof bot.is_active === 'boolean' &&
    typeof bot.created_at === 'string' &&
    typeof bot.updated_at === 'string'
  )
}

/** Load a referenced private Bot through its authorized Team, not the catalog. */
export function useTeamLeaderBot(team: Team | null, bots: Bot[], enabled: boolean) {
  const member = team?.bots.find(bot => bot.role === 'leader') || team?.bots[0]
  const catalogBot = bots.find(bot => bot.id === member?.bot_id)
  const teamId = team?.id
  const botId = member?.bot_id
  const key = enabled && teamId && botId ? `${teamId}:${botId}` : null
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{
    key: string
    bot?: Bot
    failed?: boolean
  } | null>(null)

  useEffect(() => {
    if (!key || !teamId || !botId || catalogBot) {
      setLoaded(null)
      return
    }
    const controller = new AbortController()
    setLoaded(null)
    const load = async () => {
      try {
        const detail = await teamApis.getTeam(teamId, controller.signal)
        const bot = detail.bots.find(member => member.bot_id === botId)?.bot
        if (!isBotDefinition(bot) || bot.id !== botId) {
          throw new Error('Team leader details unavailable')
        }
        if (!controller.signal.aborted) setLoaded({ key, bot })
      } catch {
        if (!controller.signal.aborted) setLoaded({ key, failed: true })
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt, botId, catalogBot, key, teamId])

  const current = key && loaded?.key === key ? loaded : null
  const bot = catalogBot || current?.bot
  return {
    bot,
    pending: Boolean(key && !bot),
    failed: current?.failed === true,
    reload: () => {
      setLoaded(null)
      setAttempt(value => value + 1)
    },
  }
}
