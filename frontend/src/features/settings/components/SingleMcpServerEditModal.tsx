// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { CodeMirrorEditor } from '@/components/common/CodeMirrorEditor'
import { useTheme } from '@/features/theme/ThemeProvider'
import { mcpProviderApis, type MCPTestResponse } from '@/apis/mcpProviders'

interface SingleMcpServerEditModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string
  serverConfig: Record<string, unknown>
  onSave: (config: Record<string, unknown>) => void
  onClose: () => void
}

const serverTypes = [
  { value: 'stdio', label: 'STDIO (Local)' },
  { value: 'sse', label: 'SSE (Server-Sent Events)' },
  { value: 'streamable-http', label: 'HTTP (Streamable)' },
  { value: 'http', label: 'HTTP' },
]

// Fields handled explicitly by the form UI; everything else is preserved as-is
const KNOWN_FORM_KEYS = new Set([
  'type',
  'command',
  'args',
  'url',
  'base_url',
  'headers',
  'transport',
])

type TestStatus = 'idle' | 'loading' | 'success' | 'error'

function extractExtraFields(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => !KNOWN_FORM_KEYS.has(k)))
}

const SingleMcpServerEditModal: React.FC<SingleMcpServerEditModalProps> = ({
  open,
  onOpenChange,
  serverName,
  serverConfig,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation('common')
  const { theme } = useTheme()

  // Form field state
  const [type, setType] = useState('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  // Unknown fields not handled by the form UI — preserved and merged back on save
  const [extraFields, setExtraFields] = useState<Record<string, unknown>>({})

  // JSON mode state
  const [jsonContent, setJsonContent] = useState('')
  const [jsonError, setJsonError] = useState(false)

  // Mode toggle: 'form' | 'json'
  const [editMode, setEditMode] = useState<'form' | 'json'>('form')

  // Test connection state
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testResult, setTestResult] = useState<MCPTestResponse | null>(null)
  const [showTools, setShowTools] = useState(false)

  // Initialize from serverConfig when modal opens
  useEffect(() => {
    if (open && serverConfig) {
      const initialType = (serverConfig.type as string) || 'stdio'
      setType(initialType)
      setCommand((serverConfig.command as string) || '')
      const initialArgs = Array.isArray(serverConfig.args)
        ? (serverConfig.args as string[]).join('\n')
        : ''
      setArgs(initialArgs)
      setUrl((serverConfig.url as string) || (serverConfig.base_url as string) || '')
      setHeaders(serverConfig.headers ? JSON.stringify(serverConfig.headers, null, 2) : '')
      setExtraFields(extractExtraFields(serverConfig))
      setJsonContent(JSON.stringify(serverConfig, null, 2))
      setJsonError(false)
      setEditMode('form')
      setTestStatus('idle')
      setTestResult(null)
      setShowTools(false)
    }
  }, [open, serverConfig])

  // Sync form fields → JSON when in form mode
  useEffect(() => {
    if (editMode !== 'form') return
    const config: Record<string, unknown> = { ...extraFields, type }
    if (type === 'stdio') {
      if (command.trim()) config.command = command.trim()
      const parsedArgs = args
        .split('\n')
        .map(a => a.trim())
        .filter(Boolean)
      if (parsedArgs.length > 0) config.args = parsedArgs
    } else {
      if (url.trim()) config.url = url.trim()
    }
    if (headers.trim()) {
      try {
        const parsedHeaders = JSON.parse(headers)
        if (Object.keys(parsedHeaders).length > 0) {
          config.headers = parsedHeaders
        }
      } catch {
        // Invalid JSON headers, skip
      }
    }
    setJsonContent(JSON.stringify(config, null, 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, command, args, url, headers, extraFields])

  const handleJsonChange = useCallback((value: string) => {
    setJsonContent(value)
    setJsonError(false)
  }, [])

  // When switching modes, sync state in the appropriate direction
  const handleSetEditMode = useCallback(
    (mode: 'form' | 'json') => {
      if (mode === 'form' && editMode === 'json') {
        // Sync JSON → form fields
        try {
          const parsed = JSON.parse(jsonContent)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            setType((parsed.type as string) || 'stdio')
            setCommand((parsed.command as string) || '')
            const parsedArgs = Array.isArray(parsed.args)
              ? (parsed.args as string[]).join('\n')
              : ''
            setArgs(parsedArgs)
            setUrl((parsed.url as string) || (parsed.base_url as string) || '')
            setHeaders(parsed.headers ? JSON.stringify(parsed.headers, null, 2) : '')
            setExtraFields(extractExtraFields(parsed))
          }
        } catch {
          // Keep current form state if JSON is invalid
        }
      }
      setEditMode(mode)
    },
    [editMode, jsonContent]
  )

  // Build current config from either form fields or JSON content
  const buildCurrentConfig = useCallback((): Record<string, unknown> => {
    if (editMode === 'json') {
      try {
        return JSON.parse(jsonContent)
      } catch {
        return {}
      }
    }
    const config: Record<string, unknown> = { ...extraFields, type }
    if (type === 'stdio') {
      if (command.trim()) config.command = command.trim()
      const parsedArgs = args
        .split('\n')
        .map(a => a.trim())
        .filter(Boolean)
      if (parsedArgs.length > 0) config.args = parsedArgs
    } else {
      if (url.trim()) config.url = url.trim()
    }
    if (headers.trim()) {
      try {
        const parsedHeaders = JSON.parse(headers)
        if (Object.keys(parsedHeaders).length > 0) config.headers = parsedHeaders
      } catch {
        /* skip */
      }
    }
    return config
  }, [editMode, jsonContent, type, command, args, url, headers, extraFields])

  const handleTest = useCallback(async () => {
    setTestStatus('loading')
    setTestResult(null)
    setShowTools(false)
    try {
      const currentConfig = buildCurrentConfig()
      const result = await mcpProviderApis.testServer({
        server_name: serverName,
        server_config: currentConfig,
      })
      if (result.success) {
        setTestStatus('success')
        setTestResult(result)
      } else {
        setTestStatus('error')
        setTestResult(result)
      }
    } catch {
      setTestStatus('error')
      setTestResult(null)
    }
  }, [buildCurrentConfig, serverName])

  const handleSave = useCallback(() => {
    if (editMode === 'json') {
      try {
        const parsed = JSON.parse(jsonContent)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setJsonError(true)
          return
        }
        onSave(parsed)
      } catch {
        setJsonError(true)
      }
    } else {
      const config: Record<string, unknown> = { ...extraFields, type }
      if (type === 'stdio') {
        if (command.trim()) config.command = command.trim()
        const parsedArgs = args
          .split('\n')
          .map(a => a.trim())
          .filter(Boolean)
        if (parsedArgs.length > 0) config.args = parsedArgs
      } else {
        if (url.trim()) config.url = url.trim()
      }
      if (headers.trim()) {
        try {
          const parsedHeaders = JSON.parse(headers)
          if (Object.keys(parsedHeaders).length > 0) {
            config.headers = parsedHeaders
          }
        } catch {
          // Invalid JSON headers, ignore
        }
      }
      onSave(config)
    }
  }, [editMode, jsonContent, type, command, args, url, headers, extraFields, onSave])

  const isHttpType = type === 'http' || type === 'streamable-http' || type === 'sse'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center justify-between mb-3">
            <DialogTitle className="text-base font-semibold text-text-primary">
              {t('common:bot.edit_mcp_server', 'Edit MCP Server')}
            </DialogTitle>
            <span className="inline-flex items-center h-6 px-3 bg-primary/10 text-primary rounded-full text-xs font-medium font-mono">
              {serverName}
            </span>
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-border">
            <button
              onClick={() => handleSetEditMode('form')}
              className={[
                'h-9 px-4 text-sm border-b-2 -mb-px transition-colors',
                editMode === 'form'
                  ? 'text-primary border-primary font-medium'
                  : 'text-text-secondary border-transparent hover:text-text-primary',
              ].join(' ')}
            >
              {t('common:bot.mcp_form_mode', 'Form Mode')}
            </button>
            <button
              onClick={() => handleSetEditMode('json')}
              className={[
                'h-9 px-4 text-sm border-b-2 -mb-px transition-colors',
                editMode === 'json'
                  ? 'text-primary border-primary font-medium'
                  : 'text-text-secondary border-transparent hover:text-text-primary',
              ].join(' ')}
            >
              {t('common:bot.mcp_json_mode', 'JSON Mode')}
            </button>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="px-5 py-4 overflow-y-auto max-h-[480px]">
          {editMode === 'form' ? (
            <div className="space-y-4">
              {/* Name + Type row */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs font-medium text-text-secondary">
                    {t('common:bot.mcp_server_name', 'Server Name')}
                  </Label>
                  <Input value={serverName} disabled className="bg-muted font-mono text-sm" />
                </div>
                <div className="w-44 space-y-1.5">
                  <Label className="text-xs font-medium text-text-secondary">
                    {t('common:bot.mcp_server_type', 'Type')}
                  </Label>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger className="text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {serverTypes.map(serverType => (
                        <SelectItem key={serverType.value} value={serverType.value}>
                          {serverType.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Command (stdio) */}
              {!isHttpType && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-text-secondary">
                    {t('common:bot.mcp_command', 'Command')}
                  </Label>
                  <Input
                    value={command}
                    onChange={e => setCommand(e.target.value)}
                    placeholder={t(
                      'common:bot.mcp_command_placeholder',
                      'e.g., npx -y @modelcontextprotocol/server-filesystem /path'
                    )}
                    className="text-sm font-mono"
                  />
                </div>
              )}

              {/* Args (stdio) */}
              {!isHttpType && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-text-secondary">
                    {t('common:bot.mcp_args', 'Arguments')}
                    <span className="text-text-muted font-normal ml-1">
                      ({t('common:bot.optional', 'optional')})
                    </span>
                  </Label>
                  <Textarea
                    value={args}
                    onChange={e => setArgs(e.target.value)}
                    placeholder={t(
                      'common:bot.mcp_args_placeholder',
                      '-y\n@modelcontextprotocol/server-filesystem\n/path'
                    )}
                    rows={3}
                    className="text-sm font-mono resize-y"
                  />
                  <p className="text-xs text-text-muted">
                    {t('common:bot.mcp_args_hint', 'One argument per line')}
                  </p>
                </div>
              )}

              {/* URL (HTTP/SSE) */}
              {isHttpType && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-text-secondary">
                    {t('common:bot.mcp_url', 'URL')}
                  </Label>
                  <Input
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder={t(
                      'common:bot.mcp_url_placeholder',
                      'e.g., http://localhost:3000/sse'
                    )}
                    className="text-sm font-mono"
                  />
                </div>
              )}

              {/* Headers */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-text-secondary">
                  {t('common:bot.mcp_headers', 'Headers')}
                  <span className="text-text-muted font-normal ml-1">
                    ({t('common:bot.optional', 'optional')})
                  </span>
                </Label>
                <Textarea
                  value={headers}
                  onChange={e => setHeaders(e.target.value)}
                  placeholder={t(
                    'common:bot.mcp_headers_placeholder',
                    '{ "Authorization": "Bearer token" }'
                  )}
                  rows={3}
                  className="text-sm font-mono resize-y"
                />
                <p className="text-xs text-text-muted">
                  {t('common:bot.mcp_headers_hint', 'JSON format')}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-text-secondary">
                {t('common:bot.mcp_server_name', 'Server Name')}
              </Label>
              <Input value={serverName} disabled className="bg-muted font-mono text-sm mb-3" />
              <Label className="text-xs font-medium text-text-secondary">
                JSON {t('common:bot.mcp_config', 'Configuration')}
              </Label>
              <div className="border border-border rounded-md overflow-hidden">
                <CodeMirrorEditor
                  value={jsonContent}
                  onChange={handleJsonChange}
                  language="json"
                  theme={theme}
                  vimEnabled={false}
                  className="h-[220px]"
                />
              </div>
              {jsonError && (
                <p className="text-xs text-red-500">
                  {t('common:bot.errors.mcp_config_json', 'Invalid JSON format')}
                </p>
              )}
            </div>
          )}

          {/* Test Connection Status — inline within content area */}
          {testStatus === 'success' && (
            <div className="flex items-center gap-2 mt-3 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-green-600">{t('common:bot.mcp_test_success')}</span>
              {testResult && (
                <span className="text-text-muted text-xs">
                  {t('common:bot.mcp_tools_count', { count: testResult.tools.length })}
                </span>
              )}
            </div>
          )}
          {testStatus === 'error' && (
            <div className="flex items-center gap-2 mt-3 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span className="text-red-600">{t('common:bot.mcp_test_failed')}</span>
              {testResult?.error && (
                <span className="text-text-muted text-xs truncate">{testResult.error}</span>
              )}
            </div>
          )}

          {/* Tool List Panel — inline within content area */}
          {showTools && testResult && testResult.tools.length > 0 && (
            <div className="border border-border rounded-md mt-2 max-h-40 overflow-y-auto">
              {testResult.tools.map(tool => (
                <div key={tool.name} className="px-3 py-2 border-b border-border last:border-b-0">
                  <div className="font-mono text-xs font-medium text-primary truncate">
                    {tool.name}
                  </div>
                  {tool.description && (
                    <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                      {tool.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3 border-t border-border gap-2">
          <div className="flex gap-2 flex-1">
            {isHttpType && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testStatus === 'loading'}
                >
                  {testStatus === 'loading'
                    ? t('common:bot.mcp_test_loading')
                    : t('common:bot.mcp_test')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTools(v => !v)}
                  disabled={testStatus !== 'success' || !testResult?.tools.length}
                >
                  {t('common:bot.mcp_tool_list')}
                </Button>
              </>
            )}
          </div>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave}>
            {t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SingleMcpServerEditModal
