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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getPublicApiBaseUrl as getConfiguredPublicApiBaseUrl } from '@/lib/runtime-config'
import type { Team } from '@/types/api'

const API_KEYS_PATH = '/settings?section=api-keys&tab=api-keys'
const RESPONSES_PATH = '/v1/responses'
const DEFAULT_INPUT = '你好，你都能做什么？'
const API_KEY_PLACEHOLDER = '<your-api-key>'
const WEGENT_CHAT_BOT_TOOL_TYPE = 'wegent_chat_bot'

export const TEAM_API_CODE_SAMPLE_LANGUAGES = [
  'curl',
  'javascript',
  'python',
  'java',
  'go',
  'rust',
] as const

export type TeamApiCodeSampleLanguage = (typeof TEAM_API_CODE_SAMPLE_LANGUAGES)[number]

export interface TeamApiCodeSample {
  language: TeamApiCodeSampleLanguage
  code: string
  isCommunitySdk?: boolean
}

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

function resolvePublicApiBaseUrl(): string {
  return typeof getConfiguredPublicApiBaseUrl === 'function'
    ? getConfiguredPublicApiBaseUrl()
    : '/api'
}

export function buildTeamApiCurl(
  team: Team,
  input: string = DEFAULT_INPUT,
  responsesEndpoint: string = buildTeamApiResponsesEndpoint(resolvePublicApiBaseUrl())
): string {
  const model = buildTeamApiModel(team)

  return [
    `curl -X POST ${JSON.stringify(responsesEndpoint)} \\`,
    '  -H "Content-Type: application/json" \\',
    `  -H "X-API-Key: ${API_KEY_PLACEHOLDER}" \\`,
    "  -d '{",
    `    "model": ${JSON.stringify(model)},`,
    `    "input": ${JSON.stringify(input)},`,
    '    "stream": true,',
    `    "tools": [{"type": ${JSON.stringify(WEGENT_CHAT_BOT_TOOL_TYPE)}}]`,
    "  }'",
  ].join('\n')
}

export function buildTeamApiSdkBaseUrl(responsesEndpoint: string): string {
  return responsesEndpoint.trim().replace(/\/responses\/?$/, '')
}

function buildSingleQuotedString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function buildTeamApiCodeSamples(
  team: Team,
  input: string = DEFAULT_INPUT,
  responsesEndpoint: string = buildTeamApiResponsesEndpoint(resolvePublicApiBaseUrl())
): TeamApiCodeSample[] {
  const model = buildTeamApiModel(team)
  const sdkBaseUrl = buildTeamApiSdkBaseUrl(responsesEndpoint)
  const quotedApiKey = JSON.stringify(API_KEY_PLACEHOLDER)
  const quotedBaseUrl = JSON.stringify(sdkBaseUrl)
  const quotedInput = JSON.stringify(input)
  const quotedModel = JSON.stringify(model)
  const quotedToolType = JSON.stringify(WEGENT_CHAT_BOT_TOOL_TYPE)
  const jsApiKey = buildSingleQuotedString(API_KEY_PLACEHOLDER)
  const jsBaseUrl = buildSingleQuotedString(sdkBaseUrl)
  const jsInput = buildSingleQuotedString(input)
  const jsModel = buildSingleQuotedString(model)
  const jsToolType = buildSingleQuotedString(WEGENT_CHAT_BOT_TOOL_TYPE)

  return [
    {
      language: 'curl',
      code: buildTeamApiCurl(team, input, responsesEndpoint),
    },
    {
      language: 'javascript',
      code: [
        "import OpenAI from 'openai'",
        '',
        'const client = new OpenAI({',
        `  apiKey: ${jsApiKey},`,
        `  baseURL: ${jsBaseUrl},`,
        '})',
        '',
        'const stream = await client.responses.create({',
        `  model: ${jsModel},`,
        `  input: ${jsInput},`,
        '  stream: true,',
        `  tools: [{ type: ${jsToolType} }],`,
        '})',
        '',
        'for await (const event of stream) {',
        "  if (event.type === 'response.output_text.delta') {",
        '    process.stdout.write(event.delta)',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      language: 'python',
      code: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    api_key=${quotedApiKey},`,
        `    base_url=${quotedBaseUrl},`,
        ')',
        '',
        'stream = client.responses.create(',
        `    model=${quotedModel},`,
        `    input=${quotedInput},`,
        '    stream=True,',
        `    tools=[{"type": ${quotedToolType}}],`,
        ')',
        '',
        'for event in stream:',
        '    if event.type == "response.output_text.delta":',
        '        print(event.delta, end="")',
      ].join('\n'),
    },
    {
      language: 'java',
      code: [
        'import com.openai.client.OpenAIClient;',
        'import com.openai.client.okhttp.OpenAIOkHttpClient;',
        'import com.openai.core.JsonValue;',
        'import com.openai.core.http.StreamResponse;',
        'import com.openai.helpers.ResponseAccumulator;',
        'import com.openai.models.ChatModel;',
        'import com.openai.models.responses.ResponseCreateParams;',
        'import com.openai.models.responses.ResponseStreamEvent;',
        'import java.util.List;',
        'import java.util.Map;',
        '',
        'public class Main {',
        '    public static void main(String[] args) throws Exception {',
        '        OpenAIClient client = OpenAIOkHttpClient.builder()',
        `            .apiKey(${quotedApiKey})`,
        '            .build()',
        '            .withOptions(options ->',
        `                options.baseUrl(${quotedBaseUrl})`,
        '            );',
        '',
        '        ResponseCreateParams params = ResponseCreateParams.builder()',
        `            .model(ChatModel.of(${quotedModel}))`,
        `            .input(${quotedInput})`,
        '            .putAdditionalBodyProperty(',
        '                "tools",',
        `                JsonValue.from(List.of(Map.of("type", ${quotedToolType})))`,
        '            )',
        '            .build();',
        '',
        '        ResponseAccumulator accumulator = ResponseAccumulator.create();',
        '        try (StreamResponse<ResponseStreamEvent> stream =',
        '                client.responses().createStreaming(params)) {',
        '            stream.stream()',
        '                .peek(accumulator::accumulate)',
        '                .flatMap(event -> event.outputTextDelta().stream())',
        '                .forEach(textEvent -> System.out.print(textEvent.delta()));',
        '        }',
        '    }',
        '}',
      ].join('\n'),
    },
    {
      language: 'go',
      code: [
        'package main',
        '',
        'import (',
        '\t"context"',
        '\t"fmt"',
        '',
        '\t"github.com/openai/openai-go/v3"',
        '\t"github.com/openai/openai-go/v3/option"',
        '\t"github.com/openai/openai-go/v3/responses"',
        ')',
        '',
        'func main() {',
        '\tctx := context.Background()',
        '\tclient := openai.NewClient(',
        `\t\toption.WithAPIKey(${quotedApiKey}),`,
        `\t\toption.WithBaseURL(${quotedBaseUrl}),`,
        '\t)',
        '',
        '\tparams := responses.ResponseNewParams{',
        `\t\tModel: openai.ChatModel(${quotedModel}),`,
        '\t\tInput: responses.ResponseNewParamsInputUnion{',
        `\t\t\tOfString: openai.String(${quotedInput}),`,
        '\t\t},',
        '\t}',
        '\tparams.SetExtraFields(map[string]any{',
        `\t\t"tools": []map[string]string{{"type": ${quotedToolType}}},`,
        '\t})',
        '',
        '\tstream := client.Responses.NewStreaming(ctx, params)',
        '\tfor stream.Next() {',
        '\t\tfmt.Print(stream.Current().Delta)',
        '\t}',
        '\tif err := stream.Err(); err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '}',
      ].join('\n'),
    },
    {
      language: 'rust',
      isCommunitySdk: true,
      code: [
        'use async_openai::{config::OpenAIConfig, Client};',
        'use futures_util::StreamExt;',
        'use serde_json::{json, Value};',
        '',
        '#[tokio::main]',
        'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
        '    let config = OpenAIConfig::new()',
        `        .with_api_key(${quotedApiKey})`,
        `        .with_api_base(${quotedBaseUrl});`,
        '    let client = Client::with_config(config);',
        '',
        '    let request = json!({',
        `        "model": ${quotedModel},`,
        `        "input": ${quotedInput},`,
        '        "stream": true,',
        `        "tools": [{ "type": ${quotedToolType} }],`,
        '    });',
        '',
        '    let mut stream = client',
        '        .responses()',
        '        .create_stream_byot::<_, Value>(request)',
        '        .await?;',
        '',
        '    while let Some(event) = stream.next().await {',
        '        let event = event?;',
        '        if event["type"].as_str() == Some("response.output_text.delta") {',
        '            if let Some(delta) = event["delta"].as_str() {',
        '                print!("{delta}");',
        '            }',
        '        }',
        '    }',
        '',
        '    Ok(())',
        '}',
      ].join('\n'),
    },
  ]
}

interface TeamApiCallButtonProps {
  team: Team
}

export function TeamApiCallButton({ team }: TeamApiCallButtonProps) {
  const { t, i18n } = useTranslation('common')
  const { toast } = useToast()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [activeSampleLanguage, setActiveSampleLanguage] =
    useState<TeamApiCodeSampleLanguage>('curl')

  const teamDisplayName = team.displayName?.trim() || team.name
  const model = useMemo(() => buildTeamApiModel(team), [team])
  const responsesEndpoint = useMemo(
    () => buildTeamApiResponsesEndpoint(resolvePublicApiBaseUrl()),
    []
  )
  const codeSamples = useMemo(
    () => buildTeamApiCodeSamples(team, DEFAULT_INPUT, responsesEndpoint),
    [team, responsesEndpoint]
  )
  const activeSample =
    codeSamples.find(sample => sample.language === activeSampleLanguage) ?? codeSamples[0]!
  const activeLanguageLabel = t(`teams.api_call.languages.${activeSample.language}`)
  const docsLanguage = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${docsLanguage}/reference/openapi-responses-api.md`

  const handleSampleLanguageChange = (value: string) => {
    if ((TEAM_API_CODE_SAMPLE_LANGUAGES as readonly string[]).includes(value)) {
      setActiveSampleLanguage(value as TeamApiCodeSampleLanguage)
    }
  }

  const handleCopySample = async () => {
    const isCurl = activeSample.language === 'curl'

    try {
      await navigator.clipboard.writeText(activeSample.code)
      toast({
        title: t(isCurl ? 'teams.api_call.copy_success' : 'teams.api_call.copy_code_success'),
      })
    } catch {
      toast({
        variant: 'destructive',
        title: t(isCurl ? 'teams.api_call.copy_failed' : 'teams.api_call.copy_code_failed'),
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
        <DialogContent className="max-w-3xl">
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
                {t('teams.api_call.code_examples')}
              </div>
              <Tabs value={activeSample.language} onValueChange={handleSampleLanguageChange}>
                <TabsList className="mb-2 h-auto max-w-full flex-wrap justify-start">
                  {codeSamples.map(sample => (
                    <TabsTrigger
                      key={sample.language}
                      value={sample.language}
                      onClick={() => setActiveSampleLanguage(sample.language)}
                      data-testid={`team-api-language-tab-${sample.language}-${team.id}`}
                    >
                      {t(`teams.api_call.languages.${sample.language}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {activeSample.isCommunitySdk && (
                  <div className="mb-2 text-xs text-text-muted">
                    {t('teams.api_call.rust_community_sdk')}
                  </div>
                )}
                {codeSamples.map(sample => (
                  <TabsContent key={sample.language} value={sample.language} className="mt-0">
                    <pre className="max-h-[360px] overflow-auto rounded-md border border-border bg-surface p-3 text-xs leading-5 text-text-primary">
                      <code>{sample.code}</code>
                    </pre>
                  </TabsContent>
                ))}
              </Tabs>
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
              onClick={handleCopySample}
              className="gap-2"
              data-testid={`copy-team-api-curl-button-${team.id}`}
            >
              <Copy className="h-4 w-4" />
              {activeSample.language === 'curl'
                ? t('teams.api_call.copy_curl')
                : t('teams.api_call.copy_sample', { language: activeLanguageLabel })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
