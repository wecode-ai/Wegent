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
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { normalizeMcpServers, parseMcpConfig } from '../utils/mcpConfig'
import type { AgentType } from '../utils/mcpTypeAdapter'

interface McpConfigEditModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialConfig: string
  onSave: (config: Record<string, unknown>) => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  agentType?: AgentType
}

const McpConfigEditModal: React.FC<McpConfigEditModalProps> = ({
  open,
  onOpenChange,
  initialConfig,
  onSave,
  toast,
  agentType,
}) => {
  const { t } = useTranslation('common')
  const [editConfig, setEditConfig] = useState('')
  const [editConfigError, setEditConfigError] = useState(false)

  useEffect(() => {
    if (open) {
      setEditConfig(initialConfig || '{}')
      setEditConfigError(false)
    }
  }, [open, initialConfig])

  const handleSave = useCallback(() => {
    try {
      const parsed = parseMcpConfig(editConfig)
      const normalized = normalizeMcpServers(parsed, agentType)
      onSave(normalized)
      setEditConfigError(false)
      onOpenChange(false)
    } catch {
      setEditConfigError(true)
      toast({
        variant: 'destructive',
        title: t('bot.errors.mcp_config_json'),
      })
    }
  }, [editConfig, agentType, onSave, onOpenChange, toast, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bot.edit_mcp_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">{t('bot.edit_mcp_desc')}</p>
          <Textarea
            value={editConfig}
            onChange={e => {
              setEditConfig(e.target.value)
              setEditConfigError(false)
            }}
            rows={14}
            className={`font-mono text-sm ${editConfigError ? 'border-red-500' : ''}`}
          />
          {editConfigError && (
            <div className="text-red-500 text-sm">{t('bot.errors.mcp_config_json')}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave}>
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default McpConfigEditModal
