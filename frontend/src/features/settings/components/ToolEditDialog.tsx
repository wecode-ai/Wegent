// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { toolApis, UnifiedTool, ToolCreateRequest, ToolUpdateRequest, McpServerConfig } from '@/apis/tools'

interface ToolEditDialogProps {
  open: boolean
  onClose: () => void
  tool: UnifiedTool | null // null for create, object for edit
  groupName?: string
}

type ToolKindType = 'builtin' | 'mcp'
type McpServerType = 'stdio' | 'sse' | 'streamable-http'

const ToolEditDialog: React.FC<ToolEditDialogProps> = ({ open, onClose, tool, groupName }) => {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)

  // Form fields
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [toolType, setToolType] = useState<ToolKindType>('mcp')
  const [description, setDescription] = useState('')
  const [builtinName, setBuiltinName] = useState('')

  // MCP Server fields
  const [mcpServerType, setMcpServerType] = useState<McpServerType>('sse')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEnv, setMcpEnv] = useState('')
  const [mcpTimeout, setMcpTimeout] = useState('300')

  const isEditMode = !!tool

  // Initialize form when dialog opens
  useEffect(() => {
    if (open) {
      if (tool) {
        // Edit mode - populate form with existing values
        setName(tool.name)
        setDisplayName(tool.displayName || '')
        setToolType(tool.toolType as ToolKindType)
        setDescription(tool.description)
        setBuiltinName(tool.builtinName || '')

        if (tool.mcpServer) {
          setMcpServerType(tool.mcpServer.type as McpServerType)
          setMcpUrl(tool.mcpServer.url || '')
          setMcpCommand(tool.mcpServer.command || '')
          setMcpArgs(tool.mcpServer.args?.join(' ') || '')
          setMcpEnv(tool.mcpServer.env ? JSON.stringify(tool.mcpServer.env, null, 2) : '')
          setMcpTimeout(String(tool.mcpServer.timeout || 300))
        }
      } else {
        // Create mode - reset form
        setName('')
        setDisplayName('')
        setToolType('mcp')
        setDescription('')
        setBuiltinName('')
        setMcpServerType('sse')
        setMcpUrl('')
        setMcpCommand('')
        setMcpArgs('')
        setMcpEnv('')
        setMcpTimeout('300')
      }
    }
  }, [open, tool])

  const validateForm = (): boolean => {
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: t('tools.errors.name_required'),
      })
      return false
    }

    // Validate name format (lowercase, alphanumeric, hyphens)
    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
    if (!nameRegex.test(name)) {
      toast({
        variant: 'destructive',
        title: t('tools.errors.name_invalid_format'),
      })
      return false
    }

    if (!description.trim()) {
      toast({
        variant: 'destructive',
        title: t('tools.errors.description_required'),
      })
      return false
    }

    if (toolType === 'builtin' && !builtinName.trim()) {
      toast({
        variant: 'destructive',
        title: t('tools.errors.builtin_name_required'),
      })
      return false
    }

    if (toolType === 'mcp') {
      if (mcpServerType === 'stdio' && !mcpCommand.trim()) {
        toast({
          variant: 'destructive',
          title: t('tools.errors.mcp_command_required'),
        })
        return false
      }
      if ((mcpServerType === 'sse' || mcpServerType === 'streamable-http') && !mcpUrl.trim()) {
        toast({
          variant: 'destructive',
          title: t('tools.errors.mcp_url_required'),
        })
        return false
      }
    }

    return true
  }

  const buildMcpServerConfig = (): McpServerConfig | undefined => {
    if (toolType !== 'mcp') return undefined

    const config: McpServerConfig = {
      type: mcpServerType,
      timeout: parseInt(mcpTimeout) || 300,
    }

    if (mcpServerType === 'stdio') {
      config.command = mcpCommand
      if (mcpArgs.trim()) {
        config.args = mcpArgs.split(' ').filter(Boolean)
      }
    } else {
      config.url = mcpUrl
    }

    if (mcpEnv.trim()) {
      try {
        config.env = JSON.parse(mcpEnv)
      } catch {
        // Invalid JSON, ignore
      }
    }

    return config
  }

  const handleSubmit = async () => {
    if (!validateForm()) return

    setLoading(true)
    try {
      if (isEditMode) {
        // Update existing tool
        const request: ToolUpdateRequest = {
          displayName: displayName || undefined,
          description,
          mcpServer: buildMcpServerConfig(),
        }
        await toolApis.updateTool(tool!.name, request)
        toast({
          title: t('tools.update_success'),
        })
      } else {
        // Create new tool
        const request: ToolCreateRequest = {
          name,
          displayName: displayName || undefined,
          type: toolType,
          description,
          builtinName: toolType === 'builtin' ? builtinName : undefined,
          mcpServer: buildMcpServerConfig(),
        }
        await toolApis.createTool(request, groupName)
        toast({
          title: t('tools.create_success'),
        })
      }
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditMode ? t('tools.errors.update_failed') : t('tools.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? t('tools.edit_tool') : t('tools.create_tool')}
          </DialogTitle>
          <DialogDescription>
            {isEditMode ? t('tools.edit_tool_description') : t('tools.create_tool_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Name field (readonly in edit mode) */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('tools.form.name')}</Label>
            <Input
              id="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('tools.form.name_placeholder')}
              disabled={isEditMode}
            />
            <p className="text-xs text-text-muted">{t('tools.form.name_hint')}</p>
          </div>

          {/* Display Name */}
          <div className="space-y-2">
            <Label htmlFor="displayName">{t('tools.form.display_name')}</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('tools.form.display_name_placeholder')}
            />
          </div>

          {/* Tool Type (readonly in edit mode) */}
          <div className="space-y-2">
            <Label>{t('tools.form.type')}</Label>
            <Select
              value={toolType}
              onValueChange={v => setToolType(v as ToolKindType)}
              disabled={isEditMode}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mcp">{t('tools.type_mcp')}</SelectItem>
                <SelectItem value="builtin">{t('tools.type_builtin')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('tools.form.description')}</Label>
            <Textarea
              id="description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('tools.form.description_placeholder')}
              rows={3}
            />
            <p className="text-xs text-text-muted">{t('tools.form.description_hint')}</p>
          </div>

          {/* Builtin-specific fields */}
          {toolType === 'builtin' && (
            <div className="space-y-2">
              <Label htmlFor="builtinName">{t('tools.form.builtin_name')}</Label>
              <Input
                id="builtinName"
                value={builtinName}
                onChange={e => setBuiltinName(e.target.value)}
                placeholder={t('tools.form.builtin_name_placeholder')}
                disabled={isEditMode}
              />
            </div>
          )}

          {/* MCP-specific fields */}
          {toolType === 'mcp' && (
            <div className="space-y-4 p-4 bg-surface rounded-md border border-border">
              <h4 className="font-medium text-sm">{t('tools.form.mcp_config')}</h4>

              {/* MCP Server Type */}
              <div className="space-y-2">
                <Label>{t('tools.form.mcp_server_type')}</Label>
                <Select
                  value={mcpServerType}
                  onValueChange={v => setMcpServerType(v as McpServerType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sse">SSE</SelectItem>
                    <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                    <SelectItem value="stdio">stdio</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* URL (for sse and streamable-http) */}
              {(mcpServerType === 'sse' || mcpServerType === 'streamable-http') && (
                <div className="space-y-2">
                  <Label htmlFor="mcpUrl">{t('tools.form.mcp_url')}</Label>
                  <Input
                    id="mcpUrl"
                    value={mcpUrl}
                    onChange={e => setMcpUrl(e.target.value)}
                    placeholder="http://localhost:8080/sse"
                  />
                </div>
              )}

              {/* Command and Args (for stdio) */}
              {mcpServerType === 'stdio' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="mcpCommand">{t('tools.form.mcp_command')}</Label>
                    <Input
                      id="mcpCommand"
                      value={mcpCommand}
                      onChange={e => setMcpCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mcpArgs">{t('tools.form.mcp_args')}</Label>
                    <Input
                      id="mcpArgs"
                      value={mcpArgs}
                      onChange={e => setMcpArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-everything"
                    />
                    <p className="text-xs text-text-muted">{t('tools.form.mcp_args_hint')}</p>
                  </div>
                </>
              )}

              {/* Environment Variables */}
              <div className="space-y-2">
                <Label htmlFor="mcpEnv">{t('tools.form.mcp_env')}</Label>
                <Textarea
                  id="mcpEnv"
                  value={mcpEnv}
                  onChange={e => setMcpEnv(e.target.value)}
                  placeholder='{"API_KEY": "your-key"}'
                  rows={2}
                />
                <p className="text-xs text-text-muted">{t('tools.form.mcp_env_hint')}</p>
              </div>

              {/* Timeout */}
              <div className="space-y-2">
                <Label htmlFor="mcpTimeout">{t('tools.form.mcp_timeout')}</Label>
                <Input
                  id="mcpTimeout"
                  type="number"
                  value={mcpTimeout}
                  onChange={e => setMcpTimeout(e.target.value)}
                  placeholder="300"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {isEditMode ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ToolEditDialog
