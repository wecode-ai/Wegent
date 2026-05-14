// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { Copy, ExternalLink, KeyRound, Plug } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getPublicApiBaseUrl } from '@/lib/runtime-config'
import type { Team } from '@/types/api'

const API_KEYS_PATH = '/settings?section=api-keys&tab=api-keys'
const RESPONSES_PATH = '/v1/responses'
const DEFAULT_INPUT = '帮我总结今天的待办'

export function buildTeamApiModel(team: Team): string {
  const namespace = team.namespace?.trim() || 'default'
  return `${namespace}#${team.name}`
}

export function buildTeamApiResponsesEndpoint(
  apiBaseUrl: string,
  origin: string = typeof window !== 'undefined' ? window.location.origin : ''
): string {
  const effectiveApiBaseUrl = apiBaseUrl.trim() || '/api'
  const responsePath = RESPONSES_PATH.replace(/^\/+/, '')

  if (effectiveApiBaseUrl.startsWith('http://') || effectiveApiBaseUrl.startsWith('https://')) {
    return new URL(responsePath, `${effectiveApiBaseUrl.replace(/\/+$/, '')}/`).toString()
  }

  if (!origin) {
    return `${effectiveApiBaseUrl.replace(/\/+$/, '')}${RESPONSES_PATH}`
  }

  const relativeApiBaseUrl = effectiveApiBaseUrl.startsWith('/')
    ? effectiveApiBaseUrl
    : `/${effectiveApiBaseUrl}`
  return new URL(
    responsePath,
    new URL(`${relativeApiBaseUrl.replace(/\/+$/, '')}/`, origin)
  ).toString()
}

export function buildTeamApiCurl(
  team: Team,
  input: string = DEFAULT_INPUT,
  responsesEndpoint: string = buildTeamApiResponsesEndpoint(getPublicApiBaseUrl())
): string {
  const model = buildTeamApiModel(team)

  return [
    `curl -X POST ${JSON.stringify(responsesEndpoint)} \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-API-Key: <your-api-key>" \\',
    "  -d '{",
    `    "model": ${JSON.stringify(model)},`,
    `    "input": ${JSON.stringify(input)},`,
    '    "stream": true,',
    '    "tools": [{"type": "wegent_chat_bot"}]',
    "  }'",
  ].join('\n')
}

interface TeamApiCallButtonProps {
  team: Team
}

export function TeamApiCallButton({ team }: TeamApiCallButtonProps) {
  const { t, i18n } = useTranslation('common')
  const { toast } = useToast()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const teamDisplayName = team.displayName?.trim() || team.name
  const model = useMemo(() => buildTeamApiModel(team), [team])
  const responsesEndpoint = useMemo(() => buildTeamApiResponsesEndpoint(getPublicApiBaseUrl()), [])
  const curl = useMemo(
    () => buildTeamApiCurl(team, DEFAULT_INPUT, responsesEndpoint),
    [team, responsesEndpoint]
  )
  const docsLanguage = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${docsLanguage}/reference/openapi-responses-api.md`

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curl)
      toast({ title: t('teams.api_call.copy_success') })
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.api_call.copy_failed'),
      })
    }
  }

  const handleManageApiKeys = () => {
    setOpen(false)
    router.push(API_KEYS_PATH)
  }

  const handleViewDocs = () => {
    window.open(docsUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title={t('teams.api_call.action')}
        aria-label={t('teams.api_call.action')}
        className="h-7 w-7 sm:h-8 sm:w-8"
        data-testid={`team-api-call-button-${team.id}`}
      >
        <Plug className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('teams.api_call.title', { name: teamDisplayName })}</DialogTitle>
            <DialogDescription>{t('teams.api_call.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border bg-surface p-3">
                <div className="text-xs font-medium text-text-muted">
                  {t('teams.api_call.endpoint')}
                </div>
                <code className="mt-1 block break-all text-sm text-text-primary">
                  {responsesEndpoint}
                </code>
              </div>
              <div className="rounded-md border border-border bg-surface p-3">
                <div className="text-xs font-medium text-text-muted">
                  {t('teams.api_call.model')}
                </div>
                <code className="mt-1 block break-all text-sm text-text-primary">{model}</code>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium text-text-muted">
                {t('teams.api_call.curl_example')}
              </div>
              <pre className="max-h-[320px] overflow-auto rounded-md border border-border bg-surface p-3 text-xs leading-5 text-text-primary">
                <code>{curl}</code>
              </pre>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={handleViewDocs}
              className="gap-2"
              data-testid={`team-api-docs-button-${team.id}`}
            >
              <ExternalLink className="h-4 w-4" />
              {t('teams.api_call.view_docs')}
            </Button>
            <Button
              variant="outline"
              onClick={handleManageApiKeys}
              className="gap-2"
              data-testid={`team-api-keys-button-${team.id}`}
            >
              <KeyRound className="h-4 w-4" />
              {t('teams.api_call.manage_api_keys')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCopyCurl}
              className="gap-2"
              data-testid={`copy-team-api-curl-button-${team.id}`}
            >
              <Copy className="h-4 w-4" />
              {t('teams.api_call.copy_curl')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
