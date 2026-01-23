'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Dialog for renting a market subscription.
 * Allows users to configure trigger settings and optionally select a model.
 */
import { useState, useCallback, useEffect } from 'react'
import { ChevronDown, Store, Clock, Bot } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { CronSchedulePicker } from './CronSchedulePicker'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { subscriptionApis } from '@/apis/subscription'
import { modelApis, UnifiedModel } from '@/apis/models'
import type { MarketSubscriptionDetail, SubscriptionTriggerType } from '@/types/subscription'
import { toast } from 'sonner'

interface RentSubscriptionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subscription: MarketSubscriptionDetail
  onSuccess: () => void
}

export function RentSubscriptionDialog({
  open,
  onOpenChange,
  subscription,
  onSuccess,
}: RentSubscriptionDialogProps) {
  const { t } = useTranslation('feed')
  const [loading, setLoading] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [triggerType, setTriggerType] = useState<SubscriptionTriggerType>('interval')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [intervalValue, setIntervalValue] = useState(1)
  const [intervalUnit, setIntervalUnit] = useState('hours')
  const [executeAt, setExecuteAt] = useState<Date | undefined>()
  const [selectedModel, setSelectedModel] = useState<string>('')

  // Initialize form with subscription info
  useEffect(() => {
    if (open && subscription) {
      const baseName = subscription.name.replace(/[^a-zA-Z0-9-_]/g, '-')
      setName(`rental-${baseName}-${Date.now().toString(36)}`)
      setDisplayName(`${subscription.display_name} (Rental)`)
      setTriggerType(subscription.trigger_type)
      // Set default trigger config based on trigger type
      if (subscription.trigger_type === 'cron') {
        setCronExpression('0 9 * * *')
      } else if (subscription.trigger_type === 'interval') {
        setIntervalValue(1)
        setIntervalUnit('hours')
      } else if (subscription.trigger_type === 'one_time') {
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        setExecuteAt(tomorrow)
      }
    }
  }, [open, subscription])

  // Load models
  useEffect(() => {
    if (open) {
      setModelsLoading(true)
      modelApis
        .getUnifiedModels()
        .then(response => {
          setModels(response.data || [])
        })
        .catch((error: unknown) => {
          console.error('Failed to load models:', error)
        })
        .finally(() => {
          setModelsLoading(false)
        })
    }
  }, [open])

  const handleSubmit = useCallback(async () => {
    // Validate
    if (!name.trim()) {
      toast.error(t('market.validation_name_required'))
      return
    }
    if (!displayName.trim()) {
      toast.error(t('market.validation_display_name_required'))
      return
    }

    // Build trigger config
    let triggerConfig: Record<string, unknown> = {}
    if (triggerType === 'cron') {
      triggerConfig = { expression: cronExpression, timezone: 'UTC' }
    } else if (triggerType === 'interval') {
      triggerConfig = { value: intervalValue, unit: intervalUnit }
    } else if (triggerType === 'one_time') {
      triggerConfig = { execute_at: executeAt?.toISOString() || '' }
    }

    setLoading(true)
    try {
      await subscriptionApis.rentSubscription(subscription.id, {
        name: name.trim(),
        display_name: displayName.trim(),
        trigger_type: triggerType,
        trigger_config: triggerConfig,
        model_ref: selectedModel ? { name: selectedModel, namespace: 'default' } : undefined,
      })
      toast.success(t('market.rent_success'))
      onSuccess()
    } catch (error) {
      console.error('Failed to rent subscription:', error)
      toast.error(t('market.rent_failed'))
    } finally {
      setLoading(false)
    }
  }, [
    name,
    displayName,
    triggerType,
    cronExpression,
    intervalValue,
    intervalUnit,
    executeAt,
    selectedModel,
    subscription.id,
    t,
    onSuccess,
  ])

  const handleTriggerTypeChange = useCallback((value: string) => {
    const type = value as SubscriptionTriggerType
    setTriggerType(type)
    // Set default config for each trigger type
    if (type === 'cron') {
      setCronExpression('0 9 * * *')
    } else if (type === 'interval') {
      setIntervalValue(1)
      setIntervalUnit('hours')
    } else if (type === 'one_time') {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(9, 0, 0, 0)
      setExecuteAt(tomorrow)
    }
  }, [])

  const selectedModelObj = models.find(m => m.name === selectedModel)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" />
            {t('market.rent_subscription')}
          </DialogTitle>
          <DialogDescription>{t('market.configure_rental')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Source subscription info */}
          <div className="rounded-lg border border-border bg-surface/50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t('market.source_subscription')}</span>
            </div>
            <div className="text-sm text-text-primary font-medium">{subscription.display_name}</div>
            {subscription.description && (
              <p className="text-xs text-text-muted mt-1">{subscription.description}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
              <span>
                {t('owner')}: {subscription.owner_username}
              </span>
              <span>{subscription.trigger_description}</span>
            </div>
          </div>

          {/* Rental name */}
          <div className="space-y-2">
            <Label htmlFor="rental-name">{t('market.rental_display_name')}</Label>
            <Input
              id="rental-name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('market.rental_display_name_placeholder')}
            />
          </div>

          {/* Trigger type */}
          <div className="space-y-2">
            <Label>{t('trigger_type')}</Label>
            <Select value={triggerType} onValueChange={handleTriggerTypeChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">{t('trigger_cron')}</SelectItem>
                <SelectItem value="interval">{t('trigger_interval')}</SelectItem>
                <SelectItem value="one_time">{t('trigger_one_time')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Trigger config */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              {t('trigger_config')}
            </Label>
            {triggerType === 'cron' && (
              <CronSchedulePicker value={cronExpression} onChange={setCronExpression} />
            )}
            {triggerType === 'interval' && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={intervalValue}
                  onChange={e => setIntervalValue(parseInt(e.target.value) || 1)}
                  className="w-24"
                />
                <Select value={intervalUnit} onValueChange={setIntervalUnit}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">{t('unit_minutes')}</SelectItem>
                    <SelectItem value="hours">{t('unit_hours')}</SelectItem>
                    <SelectItem value="days">{t('unit_days')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {triggerType === 'one_time' && (
              <DateTimePicker value={executeAt} onChange={setExecuteAt} />
            )}
          </div>

          {/* Model selection (optional) */}
          <div className="space-y-2">
            <Label>{t('market.model_selection')}</Label>
            <Popover open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelSelectorOpen}
                  className="w-full justify-between"
                  disabled={modelsLoading}
                >
                  {selectedModelObj ? (
                    <span className="truncate">
                      {selectedModelObj.displayName || selectedModelObj.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('select_model_placeholder')}</span>
                  )}
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[300px] p-0" align="start">
                <Command>
                  <CommandInput placeholder={t('search_model')} />
                  <CommandList>
                    <CommandEmpty>{t('no_model_found')}</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value=""
                        onSelect={() => {
                          setSelectedModel('')
                          setModelSelectorOpen(false)
                        }}
                      >
                        <span className="text-muted-foreground">{t('use_default_model')}</span>
                      </CommandItem>
                      {models.map(model => (
                        <CommandItem
                          key={model.name}
                          value={model.name}
                          onSelect={() => {
                            setSelectedModel(model.name)
                            setModelSelectorOpen(false)
                          }}
                        >
                          <div className="flex flex-col">
                            <span>{model.displayName || model.name}</span>
                            {model.provider && (
                              <span className="text-xs text-muted-foreground">
                                {model.provider}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Hidden info */}
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30 p-4 space-y-2">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              • {t('market.hidden_prompt')}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              • {t('market.hidden_team')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t('common:loading') : t('market.rent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
