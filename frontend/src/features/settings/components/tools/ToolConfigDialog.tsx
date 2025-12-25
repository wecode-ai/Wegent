// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { getToolsecrets, setToolsecrets } from '@/apis/tools'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import type { GhostToolDetail, EnvSchemaItem } from '@/types/tool'

interface ToolConfigDialogProps {
  open: boolean
  onClose: () => void
  ghostId: number
  tool: GhostToolDetail | null
  onSaved?: () => void
}

export default function ToolConfigDialog({
  open,
  onClose,
  ghostId,
  tool,
  onSaved,
}: ToolConfigDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showsecrets, setShowsecrets] = useState<Record<string, boolean>>({})

  const envSchema: EnvSchemaItem[] = tool?.tool?.mcp_config?.envSchema || []

  const loadExistingsecrets = useCallback(async () => {
    if (!tool?.tool_name || !ghostId) return

    setIsLoading(true)
    try {
      const result = await getToolsecrets(ghostId, tool.tool_name)
      // Initialize with existing masked values
      const initialValues: Record<string, string> = {}
      for (const schema of envSchema) {
        initialValues[schema.name] = result.env[schema.name] || schema.default || ''
      }
      setEnvValues(initialValues)
    } catch {
      // Initialize with defaults if no existing config
      const initialValues: Record<string, string> = {}
      for (const schema of envSchema) {
        initialValues[schema.name] = schema.default || ''
      }
      setEnvValues(initialValues)
    } finally {
      setIsLoading(false)
    }
  }, [ghostId, tool, envSchema])

  useEffect(() => {
    if (open && tool) {
      loadExistingsecrets()
      setShowsecrets({})
    }
  }, [open, tool, loadExistingsecrets])

  const handleSave = async () => {
    if (!tool?.tool_name) return

    setIsSaving(true)
    try {
      await setToolsecrets(ghostId, tool.tool_name, envValues)
      toast({
        title: t('common.success'),
        description: t('tools.secrets_saved'),
      })
      onSaved?.()
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_save_secrets'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleValueChange = (name: string, value: string) => {
    setEnvValues((prev) => ({ ...prev, [name]: value }))
  }

  const togglesecretVisibility = (name: string) => {
    setShowsecrets((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  const isFormValid = () => {
    for (const schema of envSchema) {
      if (schema.required && !envValues[schema.name]) {
        return false
      }
    }
    return true
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px] bg-surface">
        <DialogHeader>
          <DialogTitle>
            {t('tools.configure_tool', { toolName: tool?.tool_name || '' })}
          </DialogTitle>
          <DialogDescription>{t('tools.configure_tool_description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-4 py-4">
            {envSchema.length === 0 ? (
              <p className="text-sm text-text-secondary text-center py-4">
                {t('tools.no_config_required')}
              </p>
            ) : (
              envSchema.map((schema) => (
                <div key={schema.name} className="space-y-2">
                  <Label htmlFor={schema.name} className="flex items-center gap-2">
                    {schema.secret && <KeyIcon className="h-3 w-3 text-amber-500" />}
                    {schema.displayName || schema.name}
                    {schema.required && <span className="text-destructive">*</span>}
                  </Label>
                  <div className="relative">
                    <Input
                      id={schema.name}
                      type={schema.secret && !showsecrets[schema.name] ? 'password' : 'text'}
                      value={envValues[schema.name] || ''}
                      onChange={(e) => handleValueChange(schema.name, e.target.value)}
                      placeholder={schema.default || ''}
                      className={schema.secret ? 'pr-10' : ''}
                    />
                    {schema.secret && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => togglesecretVisibility(schema.name)}
                      >
                        {showsecrets[schema.name] ? (
                          <EyeOffIcon className="h-4 w-4" />
                        ) : (
                          <EyeIcon className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                  {schema.description && (
                    <p className="text-xs text-text-secondary">{schema.description}</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !isFormValid()}>
            {isSaving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
