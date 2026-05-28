// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PlusIcon, TrashIcon, PencilIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  adminApis,
  AdminPublicTeam,
  ChatSloganItem,
  ChatTipItem,
  ChatSloganTipsResponse,
  QuickLaunchFunctionConfig,
  QuickLaunchFunctionsResponse,
  SloganTipMode,
} from '@/apis/admin'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Common form data type for both slogans and tips
type ItemFormData = {
  zh: string
  en: string
  mode: SloganTipMode
}

function normalizeQuickLaunchFunctions(
  functions: QuickLaunchFunctionConfig[]
): QuickLaunchFunctionConfig[] {
  return functions.map((item, index) => ({
    id: item.id.trim(),
    title: item.title.trim(),
    description: item.description?.trim() || undefined,
    icon: item.icon?.trim() || undefined,
    team_id: Number(item.team_id),
    enabled: item.enabled,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    quick_phrases: (item.quick_phrases ?? []).map(phrase => phrase.trim()).filter(Boolean),
  }))
}

const SystemConfigPanel: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()

  // State
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [slogans, setSlogans] = useState<ChatSloganItem[]>([])
  const [tips, setTips] = useState<ChatTipItem[]>([])
  const [version, setVersion] = useState(0)
  const [quickLaunchFunctionsVersion, setQuickLaunchFunctionsVersion] = useState(0)
  const [publicTeams, setPublicTeams] = useState<AdminPublicTeam[]>([])
  const [quickLaunchFunctions, setQuickLaunchFunctions] = useState<QuickLaunchFunctionConfig[]>([])

  // Slogan dialog states
  const [isSloganDialogOpen, setIsSloganDialogOpen] = useState(false)
  const [isDeleteSloganDialogOpen, setIsDeleteSloganDialogOpen] = useState(false)
  const [editingSlogan, setEditingSlogan] = useState<ChatSloganItem | null>(null)
  const [editingSloganIndex, setEditingSloganIndex] = useState<number>(-1)
  const [sloganFormData, setSloganFormData] = useState<ItemFormData>({
    zh: '',
    en: '',
    mode: 'both',
  })

  // Tip dialog states
  const [isTipDialogOpen, setIsTipDialogOpen] = useState(false)
  const [isDeleteTipDialogOpen, setIsDeleteTipDialogOpen] = useState(false)
  const [editingTip, setEditingTip] = useState<ChatTipItem | null>(null)
  const [editingTipIndex, setEditingTipIndex] = useState<number>(-1)
  const [tipFormData, setTipFormData] = useState<ItemFormData>({
    zh: '',
    en: '',
    mode: 'both',
  })

  // Fetch config
  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      const [response, publicTeamsResponse, quickLaunchFunctionsResponse]: [
        ChatSloganTipsResponse,
        { total: number; items: AdminPublicTeam[] },
        QuickLaunchFunctionsResponse,
      ] = await Promise.all([
        adminApis.getSloganTipsConfig(),
        adminApis.getPublicTeams(1, 1000),
        adminApis.getQuickLaunchFunctionsConfig(),
      ])
      setSlogans(response.slogans)
      setTips(response.tips)
      setVersion(response.version)
      setQuickLaunchFunctionsVersion(quickLaunchFunctionsResponse.version)
      setQuickLaunchFunctions(quickLaunchFunctionsResponse.functions)
      setPublicTeams(publicTeamsResponse.items)
    } catch (error) {
      console.error('Failed to fetch slogan tips config:', error)
      toast({
        title: t('system_config.errors.load_failed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  // Save config
  const handleSave = async () => {
    const normalizedQuickLaunchFunctions = normalizeQuickLaunchFunctions(quickLaunchFunctions)
    const hasInvalidFunction = normalizedQuickLaunchFunctions.some(
      item => !item.id || !item.title || !item.team_id
    )
    if (hasInvalidFunction) {
      toast({
        title: t('system_config.errors.quick_launch_functions_required'),
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      const [response, quickLaunchFunctionsResponse] = await Promise.all([
        adminApis.updateSloganTipsConfig({
          slogans,
          tips,
        }),
        adminApis.updateQuickLaunchFunctionsConfig({ functions: normalizedQuickLaunchFunctions }),
      ])
      setVersion(response.version)
      setQuickLaunchFunctionsVersion(quickLaunchFunctionsResponse.version)
      setQuickLaunchFunctions(quickLaunchFunctionsResponse.functions)
      toast({
        title: t('system_config.success.updated'),
      })
    } catch (error) {
      console.error('Failed to save slogan tips config:', error)
      toast({
        title: t('system_config.errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  // ==================== Slogan Operations ====================

  const handleAddSlogan = () => {
    setEditingSlogan(null)
    setEditingSloganIndex(-1)
    setSloganFormData({ zh: '', en: '', mode: 'both' })
    setIsSloganDialogOpen(true)
  }

  const handleEditSlogan = (slogan: ChatSloganItem, index: number) => {
    setEditingSlogan(slogan)
    setEditingSloganIndex(index)
    setSloganFormData({ zh: slogan.zh, en: slogan.en, mode: slogan.mode || 'both' })
    setIsSloganDialogOpen(true)
  }

  const handleSaveSlogan = () => {
    if (!sloganFormData.zh.trim() || !sloganFormData.en.trim()) {
      toast({
        title: t('system_config.errors.slogan_required'),
        variant: 'destructive',
      })
      return
    }

    if (editingSlogan && editingSloganIndex >= 0) {
      const newSlogans = [...slogans]
      newSlogans[editingSloganIndex] = {
        ...editingSlogan,
        zh: sloganFormData.zh,
        en: sloganFormData.en,
        mode: sloganFormData.mode,
      }
      setSlogans(newSlogans)
    } else {
      const newId = slogans.length > 0 ? Math.max(...slogans.map(s => s.id)) + 1 : 1
      setSlogans([
        ...slogans,
        { id: newId, zh: sloganFormData.zh, en: sloganFormData.en, mode: sloganFormData.mode },
      ])
    }

    setIsSloganDialogOpen(false)
    setEditingSlogan(null)
    setEditingSloganIndex(-1)
  }

  const handleDeleteSloganClick = (slogan: ChatSloganItem, index: number) => {
    setEditingSlogan(slogan)
    setEditingSloganIndex(index)
    setIsDeleteSloganDialogOpen(true)
  }

  const handleConfirmDeleteSlogan = () => {
    if (editingSloganIndex >= 0) {
      setSlogans(slogans.filter((_, i) => i !== editingSloganIndex))
    }
    setIsDeleteSloganDialogOpen(false)
    setEditingSlogan(null)
    setEditingSloganIndex(-1)
  }

  // ==================== Tip Operations ====================

  const handleAddTip = () => {
    setEditingTip(null)
    setEditingTipIndex(-1)
    setTipFormData({ zh: '', en: '', mode: 'both' })
    setIsTipDialogOpen(true)
  }

  const handleEditTip = (tip: ChatTipItem, index: number) => {
    setEditingTip(tip)
    setEditingTipIndex(index)
    setTipFormData({ zh: tip.zh, en: tip.en, mode: tip.mode || 'both' })
    setIsTipDialogOpen(true)
  }

  const handleSaveTip = () => {
    if (!tipFormData.zh.trim() || !tipFormData.en.trim()) {
      toast({
        title: t('system_config.errors.tip_required'),
        variant: 'destructive',
      })
      return
    }

    if (editingTip && editingTipIndex >= 0) {
      const newTips = [...tips]
      newTips[editingTipIndex] = {
        ...editingTip,
        zh: tipFormData.zh,
        en: tipFormData.en,
        mode: tipFormData.mode,
      }
      setTips(newTips)
    } else {
      const newId = tips.length > 0 ? Math.max(...tips.map(t => t.id)) + 1 : 1
      setTips([
        ...tips,
        { id: newId, zh: tipFormData.zh, en: tipFormData.en, mode: tipFormData.mode },
      ])
    }

    setIsTipDialogOpen(false)
    setEditingTip(null)
    setEditingTipIndex(-1)
  }

  const handleDeleteTipClick = (tip: ChatTipItem, index: number) => {
    setEditingTip(tip)
    setEditingTipIndex(index)
    setIsDeleteTipDialogOpen(true)
  }

  const handleConfirmDeleteTip = () => {
    if (editingTipIndex >= 0) {
      setTips(tips.filter((_, i) => i !== editingTipIndex))
    }
    setIsDeleteTipDialogOpen(false)
    setEditingTip(null)
    setEditingTipIndex(-1)
  }

  // ==================== Quick Launch Function Operations ====================

  const handleAddQuickLaunchFunction = () => {
    const nextIndex = quickLaunchFunctions.length + 1
    setQuickLaunchFunctions([
      ...quickLaunchFunctions,
      {
        id: `system_function_${nextIndex}`,
        title: '',
        description: '',
        icon: '',
        team_id: publicTeams[0]?.id || 0,
        enabled: true,
        order: nextIndex,
        quick_phrases: [],
      },
    ])
  }

  const updateQuickLaunchFunction = (index: number, patch: Partial<QuickLaunchFunctionConfig>) => {
    setQuickLaunchFunctions(prev =>
      prev.map((item, currentIndex) => (currentIndex === index ? { ...item, ...patch } : item))
    )
  }

  const removeQuickLaunchFunction = (index: number) => {
    setQuickLaunchFunctions(prev => prev.filter((_, currentIndex) => currentIndex !== index))
  }

  const updateQuickLaunchPhrase = (functionIndex: number, phraseIndex: number, phrase: string) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    const phrases =
      (currentFunction.quick_phrases ?? []).length > 0 ? [...currentFunction.quick_phrases] : ['']
    phrases[phraseIndex] = phrase
    updateQuickLaunchFunction(functionIndex, { quick_phrases: phrases })
  }

  const addQuickLaunchPhrase = (functionIndex: number) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction || (currentFunction.quick_phrases ?? []).length >= 6) return

    updateQuickLaunchFunction(functionIndex, {
      quick_phrases: [...(currentFunction.quick_phrases ?? []), ''],
    })
  }

  const removeQuickLaunchPhrase = (functionIndex: number, phraseIndex: number) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    updateQuickLaunchFunction(functionIndex, {
      quick_phrases: (currentFunction.quick_phrases ?? []).filter(
        (_, currentIndex) => currentIndex !== phraseIndex
      ),
    })
  }

  // ==================== Render ====================

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-text-muted">{t('system_config.loading')}</span>
      </div>
    )
  }

  // Reusable item list component
  const renderItemList = (
    items: (ChatSloganItem | ChatTipItem)[],
    onEdit: (item: ChatSloganItem | ChatTipItem, index: number) => void,
    onDelete: (item: ChatSloganItem | ChatTipItem, index: number) => void,
    emptyMessage: string
  ) => {
    if (items.length === 0) {
      return <div className="text-center py-8 text-text-muted">{emptyMessage}</div>
    }

    return (
      <div className="space-y-3">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="flex items-start gap-3 p-3 rounded-lg bg-surface border border-border"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-text-primary truncate flex-1">{item.zh}</p>
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary flex-shrink-0">
                  {t(`system_config.mode_${item.mode || 'both'}`)}
                </span>
              </div>
              <p className="text-xs text-text-muted truncate mt-1">{item.en}</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onEdit(item, index)}
              >
                <PencilIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-red-500 hover:text-red-600"
                onClick={() => onDelete(item, index)}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Reusable edit dialog component
  const renderEditDialog = (
    isOpen: boolean,
    onOpenChange: (open: boolean) => void,
    title: string,
    formData: ItemFormData,
    setFormData: (data: ItemFormData) => void,
    onSave: () => void,
    zhLabel: string,
    zhPlaceholder: string,
    enLabel: string,
    enPlaceholder: string
  ) => (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('system_config.dialog_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label htmlFor="item-zh">{zhLabel}</Label>
            <Textarea
              id="item-zh"
              value={formData.zh}
              onChange={e => setFormData({ ...formData, zh: e.target.value })}
              placeholder={zhPlaceholder}
              className="mt-1"
              rows={2}
            />
          </div>
          <div>
            <Label htmlFor="item-en">{enLabel}</Label>
            <Textarea
              id="item-en"
              value={formData.en}
              onChange={e => setFormData({ ...formData, en: e.target.value })}
              placeholder={enPlaceholder}
              className="mt-1"
              rows={2}
            />
          </div>
          <div>
            <Label htmlFor="item-mode">{t('system_config.mode')}</Label>
            <Select
              value={formData.mode || 'both'}
              onValueChange={(value: SloganTipMode) => setFormData({ ...formData, mode: value })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t('system_config.mode')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">{t('system_config.mode_chat')}</SelectItem>
                <SelectItem value="code">{t('system_config.mode_code')}</SelectItem>
                <SelectItem value="both">{t('system_config.mode_both')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={onSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  // Reusable delete confirmation dialog
  const renderDeleteDialog = (
    isOpen: boolean,
    onOpenChange: (open: boolean) => void,
    title: string,
    message: string,
    onConfirm: () => void
  ) => (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('common.delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{t('system_config.title')}</h2>
          <p className="text-sm text-text-muted">{t('system_config.description')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>

      {/* Slogan Configuration */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-text-primary">
            {t('system_config.slogan_title')}
          </h3>
          <Button variant="outline" size="sm" onClick={handleAddSlogan}>
            <PlusIcon className="h-4 w-4 mr-1" />
            {t('system_config.add_slogan')}
          </Button>
        </div>
        {renderItemList(
          slogans,
          handleEditSlogan as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          handleDeleteSloganClick as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          t('system_config.no_slogans')
        )}
      </Card>

      {/* Tips Configuration */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-text-primary">{t('system_config.tips_title')}</h3>
          <Button variant="outline" size="sm" onClick={handleAddTip}>
            <PlusIcon className="h-4 w-4 mr-1" />
            {t('system_config.add_tip')}
          </Button>
        </div>
        {renderItemList(
          tips,
          handleEditTip as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          handleDeleteTipClick as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          t('system_config.no_tips')
        )}
      </Card>

      {/* Quick Launch System Functions Configuration */}
      <Card className="p-6" data-testid="quick-launch-functions-section">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-md font-medium text-text-primary">
              {t('system_config.quick_launch_functions_title')}
            </h3>
            <p className="text-sm text-text-muted mt-1">
              {t('system_config.quick_launch_functions_description')}
            </p>
          </div>
          <span className="text-xs text-text-muted flex-shrink-0">
            {t('system_config.quick_launch_functions_version')}: {quickLaunchFunctionsVersion}
          </span>
        </div>
        <div className="space-y-4">
          {quickLaunchFunctions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
              {t('system_config.quick_launch_function_empty')}
            </div>
          ) : (
            quickLaunchFunctions.map((item, index) => {
              const phrases = (item.quick_phrases ?? []).length > 0 ? item.quick_phrases : ['']
              return (
                <div
                  key={`${item.id}-${index}`}
                  className="space-y-4 rounded-md border border-border bg-base p-4"
                  data-testid={`quick-launch-function-card-${index}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-medium text-text-primary">
                        {item.title || t('system_config.quick_launch_function_untitled')}
                      </h4>
                      <p className="mt-0.5 text-xs text-text-muted">{item.id}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600"
                      onClick={() => removeQuickLaunchFunction(index)}
                      data-testid={`remove-quick-launch-function-${index}`}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`quick-launch-function-id-${index}`}>
                        {t('system_config.quick_launch_function_id')}
                      </Label>
                      <Input
                        id={`quick-launch-function-id-${index}`}
                        value={item.id}
                        onChange={event =>
                          updateQuickLaunchFunction(index, { id: event.target.value })
                        }
                        data-testid={`quick-launch-function-id-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`quick-launch-function-title-${index}`}>
                        {t('system_config.quick_launch_function_title')}
                      </Label>
                      <Input
                        id={`quick-launch-function-title-${index}`}
                        value={item.title}
                        onChange={event =>
                          updateQuickLaunchFunction(index, { title: event.target.value })
                        }
                        data-testid={`quick-launch-function-title-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`quick-launch-function-team-${index}`}>
                        {t('system_config.quick_launch_function_team')}
                      </Label>
                      <select
                        id={`quick-launch-function-team-${index}`}
                        value={item.team_id || ''}
                        onChange={event =>
                          updateQuickLaunchFunction(index, { team_id: Number(event.target.value) })
                        }
                        className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        data-testid={`quick-launch-function-team-${index}`}
                      >
                        <option value="">
                          {t('system_config.quick_launch_function_team_placeholder')}
                        </option>
                        {publicTeams.map(team => (
                          <option key={team.id} value={team.id}>
                            {team.display_name || team.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`quick-launch-function-order-${index}`}>
                        {t('system_config.quick_launch_function_order')}
                      </Label>
                      <Input
                        id={`quick-launch-function-order-${index}`}
                        type="number"
                        value={item.order}
                        onChange={event =>
                          updateQuickLaunchFunction(index, { order: Number(event.target.value) })
                        }
                        data-testid={`quick-launch-function-order-${index}`}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`quick-launch-function-icon-${index}`}>
                        {t('system_config.quick_launch_function_icon')}
                      </Label>
                      <Input
                        id={`quick-launch-function-icon-${index}`}
                        value={item.icon || ''}
                        onChange={event =>
                          updateQuickLaunchFunction(index, { icon: event.target.value })
                        }
                        data-testid={`quick-launch-function-icon-${index}`}
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                      <Label htmlFor={`quick-launch-function-enabled-${index}`}>
                        {t('system_config.quick_launch_function_enabled')}
                      </Label>
                      <Switch
                        id={`quick-launch-function-enabled-${index}`}
                        checked={item.enabled}
                        onCheckedChange={checked =>
                          updateQuickLaunchFunction(index, { enabled: checked })
                        }
                        data-testid={`quick-launch-function-enabled-${index}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`quick-launch-function-description-${index}`}>
                      {t('system_config.quick_launch_function_description')}
                    </Label>
                    <Textarea
                      id={`quick-launch-function-description-${index}`}
                      value={item.description || ''}
                      onChange={event =>
                        updateQuickLaunchFunction(index, { description: event.target.value })
                      }
                      rows={2}
                      data-testid={`quick-launch-function-description-${index}`}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('system_config.quick_launch_function_phrases')}</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => addQuickLaunchPhrase(index)}
                        disabled={(item.quick_phrases ?? []).length >= 6}
                        data-testid={`add-quick-launch-function-phrase-${index}`}
                      >
                        <PlusIcon className="h-4 w-4" />
                        {t('system_config.quick_launch_function_add_phrase')}
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {phrases.map((phrase, phraseIndex) => (
                        <div key={phraseIndex} className="flex items-center gap-2">
                          <Input
                            value={phrase}
                            maxLength={120}
                            onChange={event =>
                              updateQuickLaunchPhrase(index, phraseIndex, event.target.value)
                            }
                            placeholder={t(
                              'system_config.quick_launch_function_phrase_placeholder'
                            )}
                            data-testid={`quick-launch-function-phrase-${index}-${phraseIndex}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 text-text-muted hover:text-text-primary"
                            onClick={() => removeQuickLaunchPhrase(index, phraseIndex)}
                            data-testid={`remove-quick-launch-function-phrase-${index}-${phraseIndex}`}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddQuickLaunchFunction}
            data-testid="add-quick-launch-function"
          >
            <PlusIcon className="h-4 w-4" />
            {t('system_config.quick_launch_function_add')}
          </Button>
        </div>
      </Card>

      {/* Version Info */}
      <div className="text-xs text-text-muted text-right">
        {t('system_config.version')}: {version}
      </div>

      {/* Slogan Dialogs */}
      {renderEditDialog(
        isSloganDialogOpen,
        setIsSloganDialogOpen,
        editingSlogan ? t('system_config.edit_slogan') : t('system_config.add_slogan'),
        sloganFormData,
        setSloganFormData,
        handleSaveSlogan,
        t('system_config.slogan_zh'),
        t('system_config.slogan_zh_placeholder'),
        t('system_config.slogan_en'),
        t('system_config.slogan_en_placeholder')
      )}
      {renderDeleteDialog(
        isDeleteSloganDialogOpen,
        setIsDeleteSloganDialogOpen,
        t('system_config.delete_slogan_title'),
        t('system_config.delete_slogan_message'),
        handleConfirmDeleteSlogan
      )}

      {/* Tip Dialogs */}
      {renderEditDialog(
        isTipDialogOpen,
        setIsTipDialogOpen,
        editingTip ? t('system_config.edit_tip') : t('system_config.add_tip'),
        tipFormData,
        setTipFormData,
        handleSaveTip,
        t('system_config.tip_zh'),
        t('system_config.tip_zh_placeholder'),
        t('system_config.tip_en'),
        t('system_config.tip_en_placeholder')
      )}
      {renderDeleteDialog(
        isDeleteTipDialogOpen,
        setIsDeleteTipDialogOpen,
        t('system_config.delete_tip_title'),
        t('system_config.delete_tip_message'),
        handleConfirmDeleteTip
      )}
    </div>
  )
}

export default SystemConfigPanel
