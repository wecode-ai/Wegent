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

  // Form mode state
  const [type, setType] = useState('stdio')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')

  // JSON mode state
  const [jsonContent, setJsonContent] = useState('')
  const [jsonError, setJsonError] = useState(false)

  // Mode toggle: 'form' | 'json'
  const [editMode, setEditMode] = useState<'form' | 'json'>('form')

  // Initialize from serverConfig
  useEffect(() => {
    if (open && serverConfig) {
      const initialType = (serverConfig.type as string) || 'stdio'
      setType(initialType)
      setCommand((serverConfig.command as string) || '')
      setUrl((serverConfig.url as string) || (serverConfig.base_url as string) || '')
      setHeaders(serverConfig.headers ? JSON.stringify(serverConfig.headers, null, 2) : '')
      setJsonContent(JSON.stringify(serverConfig, null, 2))
      setJsonError(false)
    }
  }, [open, serverConfig])

  // Sync JSON when form changes
  useEffect(() => {
    if (editMode === 'form') {
      const config: Record<string, unknown> = { type }
      if (type === 'stdio') {
        if (command.trim()) config.command = command.trim()
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
          // Invalid JSON, skip headers
        }
      }
      setJsonContent(JSON.stringify(config, null, 2))
    }
  }, [editMode, type, command, url, headers])

  // Sync form when JSON changes (only when switching to form mode)
  const handleJsonChange = useCallback((value: string) => {
    setJsonContent(value)
    setJsonError(false)
  }, [])

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
      const config: Record<string, unknown> = { type }
      if (type === 'stdio') {
        if (command.trim()) config.command = command.trim()
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
          // Invalid JSON, ignore headers
        }
      }
      onSave(config)
    }
  }, [editMode, jsonContent, type, command, url, headers, onSave])

  const isHttpType = type === 'http' || type === 'streamable-http' || type === 'sse'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-text-primary">
            {t('common:bot.edit_mcp_server', 'Edit MCP Server')}
          </DialogTitle>
        </DialogHeader>

        {/* Mode Toggle */}
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Button
            variant={editMode === 'form' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setEditMode('form')}
            className="text-xs"
          >
            {t('common:bot.mcp_form_mode', 'Form Mode')}
          </Button>
          <Button
            variant={editMode === 'json' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setEditMode('json')}
            className="text-xs"
          >
            {t('common:bot.mcp_json_mode', 'JSON Mode')}
          </Button>
        </div>

        {editMode === 'form' ? (
          <div className="space-y-4 py-4">
            {/* Server Name (Read-only) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-text-primary">
                {t('common:bot.mcp_server_name', 'Server Name')}
              </Label>
              <Input value={serverName} disabled className="bg-muted" />
            </div>

            {/* Type Selection */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-text-primary">
                {t('common:bot.mcp_server_type', 'Type')}
              </Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {serverTypes.map(t => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Command (for stdio) */}
            {!isHttpType && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-text-primary">
                  {t('common:bot.mcp_command', 'Command')}
                </Label>
                <Input
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  placeholder={t(
                    'common:bot.mcp_command_placeholder',
                    'e.g., npx -y @modelcontextprotocol/server-filesystem /path'
                  )}
                />
              </div>
            )}

            {/* URL (for HTTP/SSE) */}
            {isHttpType && (
              <div className="space-y-2">
                <Label className="text-sm font-medium text-text-primary">
                  {t('common:bot.mcp_url', 'URL')}
                </Label>
                <Input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder={t(
                    'common:bot.mcp_url_placeholder',
                    'e.g., http://localhost:3000/sse'
                  )}
                />
              </div>
            )}

            {/* Headers */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-text-primary">
                {t('common:bot.mcp_headers', 'Headers')} ({t('common:bot.optional', 'optional')})
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
          <div className="space-y-4 py-4">
            {/* Server Name (Read-only) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-text-primary">
                {t('common:bot.mcp_server_name', 'Server Name')}
              </Label>
              <Input value={serverName} disabled className="bg-muted" />
            </div>

            {/* JSON Editor */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-text-primary">
                JSON {t('common:bot.mcp_config', 'Configuration')}
              </Label>
              <div className="border border-border rounded-md overflow-hidden">
                <CodeMirrorEditor
                  value={jsonContent}
                  onChange={handleJsonChange}
                  language="json"
                  theme={theme}
                  vimEnabled={false}
                  className="h-[200px]"
                />
              </div>
              {jsonError && (
                <p className="text-xs text-red-500">
                  {t('common:bot.errors.mcp_config_json', 'Invalid JSON format')}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
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
