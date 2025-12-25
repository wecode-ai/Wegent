// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { EyeIcon, EyeOffIcon, Loader2Icon, KeyIcon } from 'lucide-react'
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
import { GhostSkill, EnvSchemaItem } from '@/types/skill'
import { getSkillsecrets, setSkillsecrets } from '@/apis/skills'
import LoadingState from '@/features/common/LoadingState'

interface SkillConfigDialogProps {
  open: boolean
  onClose: (saved: boolean) => void
  ghostId: number
  skill: GhostSkill
}

export default function SkillConfigDialog({
  open,
  onClose,
  ghostId,
  skill,
}: SkillConfigDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [envSchema, setEnvSchema] = useState<EnvSchemaItem[]>([])
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  const loadConfig = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await getSkillsecrets(ghostId, skill.name)
      setEnvSchema(response.envSchema)
      setEnvValues(response.values)
      // Initialize show state for all fields
      const initialShowState: Record<string, boolean> = {}
      response.envSchema.forEach(item => {
        initialShowState[item.name] = false
      })
      setShowSecrets(initialShowState)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_load'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [ghostId, skill.name, toast, t])

  useEffect(() => {
    if (open) {
      loadConfig()
    }
  }, [open, loadConfig])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      // Filter out empty values
      const filteredValues: Record<string, string> = {}
      Object.entries(envValues).forEach(([key, value]) => {
        if (value && value.trim()) {
          filteredValues[key] = value.trim()
        }
      })

      await setSkillsecrets(ghostId, skill.name, filteredValues)
      toast({
        title: t('common.success'),
        description: t('tools.secrets_saved'),
      })
      onClose(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_save'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleValueChange = (name: string, value: string) => {
    setEnvValues(prev => ({
      ...prev,
      [name]: value,
    }))
  }

  const toggleShowSecret = (name: string) => {
    setShowSecrets(prev => ({
      ...prev,
      [name]: !prev[name],
    }))
  }

  const isValueMasked = (value: string) => {
    return value && value.includes('****')
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[500px] bg-surface">
        <DialogHeader>
          <DialogTitle>{t('tools.configure_tool', { toolName: skill.name })}</DialogTitle>
          <DialogDescription>{t('tools.configure_tool_description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8">
            <LoadingState message={t('tools.loading')} />
          </div>
        ) : envSchema.length === 0 ? (
          <div className="py-8 text-center text-text-muted">
            <KeyIcon className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('tools.no_config_required')}</p>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            {envSchema.map(item => (
              <div key={item.name} className="space-y-2">
                <Label htmlFor={item.name} className="flex items-center gap-2">
                  <span>{item.displayName || item.name}</span>
                  {item.required && <span className="text-error">*</span>}
                  {item.secret && (
                    <KeyIcon className="w-3 h-3 text-warning" title={t('tools.sensitive_field')} />
                  )}
                </Label>
                {item.description && (
                  <p className="text-xs text-text-muted">{item.description}</p>
                )}
                <div className="relative">
                  <Input
                    id={item.name}
                    type={item.secret && !showSecrets[item.name] ? 'password' : 'text'}
                    value={envValues[item.name] || ''}
                    onChange={e => handleValueChange(item.name, e.target.value)}
                    placeholder={
                      item.default
                        ? t('tools.default_value', { value: item.default })
                        : item.required
                          ? t('tools.required_field')
                          : t('tools.optional_field')
                    }
                    className={`pr-10 ${isValueMasked(envValues[item.name] || '') ? 'text-text-muted' : ''}`}
                  />
                  {item.secret && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => toggleShowSecret(item.name)}
                    >
                      {showSecrets[item.name] ? (
                        <EyeOffIcon className="w-4 h-4" />
                      ) : (
                        <EyeIcon className="w-4 h-4" />
                      )}
                    </Button>
                  )}
                </div>
                {isValueMasked(envValues[item.name] || '') && (
                  <p className="text-xs text-text-muted">
                    {t('tools.value_masked_hint')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={isSaving}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading}>
            {isSaving ? (
              <>
                <Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
                {t('actions.saving')}
              </>
            ) : (
              t('actions.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
