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
import { Loader2, Paperclip, Upload } from 'lucide-react'
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
import { adminApis } from '@/apis/admin'
import type {
  AdminPublicTeam,
  ChatSloganItem,
  ChatTipItem,
  ChatSloganTipsResponse,
  QuickLaunchFunctionConfig,
  QuickLaunchFunctionsResponse,
  QuickLaunchInputPreset,
  SloganTipMode,
} from '@/apis/admin'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatFileSize, uploadAttachment } from '@/apis/attachments'

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
    input_presets: normalizeQuickLaunchInputPresets(item.input_presets),
  }))
}

function createEmptyInputPreset(index: number): QuickLaunchInputPreset {
  return {
    id: `preset_${index + 1}`,
    title: '',
    prompt: '',
    options: {
      selected_skill_names: [],
    },
  }
}

function normalizeSkillNames(value: string[] | undefined): string[] {
  const names = new Set<string>()
  for (const name of value ?? []) {
    const trimmed = name.trim()
    if (trimmed) {
      names.add(trimmed)
    }
  }
  return Array.from(names)
}

function normalizeAttachmentIds(value: number[] | undefined): number[] {
  const ids = new Set<number>()
  for (const id of value ?? []) {
    if (Number.isInteger(id) && id > 0) {
      ids.add(id)
    }
  }
  return Array.from(ids)
}

function normalizeQuickLaunchInputPresets(
  presets: QuickLaunchInputPreset[] | undefined
): QuickLaunchInputPreset[] {
  return (presets ?? [])
    .map((preset, index) => {
      const sourceAttachmentIds = normalizeAttachmentIds(preset.source_attachment_ids)
      return {
        id: preset.id.trim() || `preset_${index + 1}`,
        title: preset.title.trim(),
        prompt: preset.prompt?.trim() || undefined,
        options: {
          enable_deep_thinking: preset.options?.enable_deep_thinking ?? undefined,
          enable_clarification: preset.options?.enable_clarification ?? undefined,
          force_override: preset.options?.force_override ?? undefined,
          selected_skill_names: normalizeSkillNames(preset.options?.selected_skill_names),
        },
        source_attachment_ids: sourceAttachmentIds,
      }
    })
    .filter(
      preset => preset.title || preset.prompt || (preset.source_attachment_ids ?? []).length > 0
    )
    .map(preset => ({
      ...preset,
      title: preset.title || preset.prompt || preset.id,
    }))
}

function getEditableInputPresets(item: QuickLaunchFunctionConfig): QuickLaunchInputPreset[] {
  return item.input_presets?.length > 0 ? item.input_presets : [createEmptyInputPreset(0)]
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
  const [editingQuickLaunchFunctionIndex, setEditingQuickLaunchFunctionIndex] = useState<
    number | null
  >(null)
  const [uploadingQuickLaunchPresetKey, setUploadingQuickLaunchPresetKey] = useState<string | null>(
    null
  )
  const [quickLaunchAttachmentLabels, setQuickLaunchAttachmentLabels] = useState<
    Record<number, string>
  >({})

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
      const [sloganResult, quickLaunchFunctionsResult] = await Promise.allSettled([
        adminApis.updateSloganTipsConfig({
          slogans,
          tips,
        }),
        adminApis.updateQuickLaunchFunctionsConfig({ functions: normalizedQuickLaunchFunctions }),
      ] as const)

      if (sloganResult.status === 'fulfilled') {
        setVersion(sloganResult.value.version)
      }
      if (quickLaunchFunctionsResult.status === 'fulfilled') {
        setQuickLaunchFunctionsVersion(quickLaunchFunctionsResult.value.version)
        setQuickLaunchFunctions(quickLaunchFunctionsResult.value.functions)
      }

      const failedResults = [sloganResult, quickLaunchFunctionsResult].filter(
        result => result.status === 'rejected'
      )
      if (failedResults.length > 0) {
        console.error('Failed to save system config sections:', failedResults)
        toast({
          title:
            failedResults.length === 2
              ? t('system_config.errors.save_failed')
              : t('system_config.errors.partial_save_failed'),
          variant: 'destructive',
        })
        return
      }

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
    setQuickLaunchFunctions(prev => [
      ...prev,
      {
        id: `system_function_${nextIndex}`,
        title: '',
        description: '',
        icon: '',
        team_id: publicTeams[0]?.id || 0,
        enabled: true,
        order: nextIndex,
        input_presets: [],
      },
    ])
    setEditingQuickLaunchFunctionIndex(quickLaunchFunctions.length)
  }

  const updateQuickLaunchFunction = (index: number, patch: Partial<QuickLaunchFunctionConfig>) => {
    setQuickLaunchFunctions(prev =>
      prev.map((item, currentIndex) => (currentIndex === index ? { ...item, ...patch } : item))
    )
  }

  const removeQuickLaunchFunction = (index: number) => {
    setQuickLaunchFunctions(prev => prev.filter((_, currentIndex) => currentIndex !== index))
    setEditingQuickLaunchFunctionIndex(currentIndex => {
      if (currentIndex === null) return null
      if (currentIndex === index) return null
      return currentIndex > index ? currentIndex - 1 : currentIndex
    })
  }

  const updateQuickLaunchPreset = (
    functionIndex: number,
    presetIndex: number,
    patch: Partial<QuickLaunchInputPreset>
  ) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    const presets = getEditableInputPresets(currentFunction).map((preset, currentIndex) =>
      currentIndex === presetIndex ? { ...preset, ...patch } : preset
    )
    updateQuickLaunchFunction(functionIndex, { input_presets: presets })
  }

  const updateQuickLaunchPresetOptions = (
    functionIndex: number,
    presetIndex: number,
    optionsPatch: NonNullable<QuickLaunchInputPreset['options']>
  ) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    const preset = getEditableInputPresets(currentFunction)[presetIndex]
    if (!preset) return

    updateQuickLaunchPreset(functionIndex, presetIndex, {
      options: {
        ...preset.options,
        ...optionsPatch,
      },
    })
  }

  const addQuickLaunchPreset = (functionIndex: number) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction || (currentFunction.input_presets ?? []).length >= 6) return

    updateQuickLaunchFunction(functionIndex, {
      input_presets: [
        ...(currentFunction.input_presets ?? []),
        createEmptyInputPreset(currentFunction.input_presets?.length ?? 0),
      ],
    })
  }

  const removeQuickLaunchPreset = (functionIndex: number, presetIndex: number) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    updateQuickLaunchFunction(functionIndex, {
      input_presets: (currentFunction.input_presets ?? []).filter(
        (_, currentIndex) => currentIndex !== presetIndex
      ),
    })
  }

  const removeQuickLaunchPresetAttachment = (
    functionIndex: number,
    presetIndex: number,
    attachmentId: number
  ) => {
    const currentFunction = quickLaunchFunctions[functionIndex]
    if (!currentFunction) return

    const preset = getEditableInputPresets(currentFunction)[presetIndex]
    if (!preset) return

    updateQuickLaunchPreset(functionIndex, presetIndex, {
      source_attachment_ids: (preset.source_attachment_ids ?? []).filter(id => id !== attachmentId),
    })
  }

  const handleQuickLaunchPresetUpload = async (
    functionIndex: number,
    presetIndex: number,
    files: FileList | null
  ) => {
    const file = files?.[0]
    if (!file) return

    const uploadKey = `${functionIndex}-${presetIndex}`
    setUploadingQuickLaunchPresetKey(uploadKey)
    try {
      const attachment = await uploadAttachment(file)
      setQuickLaunchAttachmentLabels(prev => ({
        ...prev,
        [attachment.id]: `${attachment.filename} - ${formatFileSize(attachment.file_size)}`,
      }))

      const currentFunction = quickLaunchFunctions[functionIndex]
      const preset = currentFunction ? getEditableInputPresets(currentFunction)[presetIndex] : null
      if (!preset) return

      updateQuickLaunchPreset(functionIndex, presetIndex, {
        source_attachment_ids: Array.from(
          new Set([...(preset.source_attachment_ids ?? []), attachment.id])
        ),
      })
    } catch (error) {
      console.error('Failed to upload quick launch preset attachment:', error)
      toast({
        title: t('system_config.errors.quick_launch_attachment_upload_failed'),
        variant: 'destructive',
      })
    } finally {
      setUploadingQuickLaunchPresetKey(null)
    }
  }

  // ==================== Render ====================

  const editingQuickLaunchFunction =
    editingQuickLaunchFunctionIndex === null
      ? null
      : quickLaunchFunctions[editingQuickLaunchFunctionIndex] || null

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
                className="h-11 min-w-[44px]"
                onClick={() => onEdit(item, index)}
              >
                <PencilIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 min-w-[44px] text-red-500 hover:text-red-600"
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
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={onSave}>
            {t('common:actions.save')}
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
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('common:actions.delete')}</AlertDialogAction>
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
          {t('common:actions.save')}
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
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-md font-medium text-text-primary">
              {t('system_config.quick_launch_functions_title')}
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              {t('system_config.quick_launch_functions_description')}
            </p>
            <p className="mt-2 text-xs text-text-muted">
              {t('system_config.quick_launch_functions_version')}: {quickLaunchFunctionsVersion}
            </p>
          </div>
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

        <div className="space-y-2">
          {quickLaunchFunctions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
              {t('system_config.quick_launch_function_empty')}
            </div>
          ) : (
            quickLaunchFunctions.map((item, index) => {
              const team = publicTeams.find(publicTeam => publicTeam.id === item.team_id)
              const presetCount = item.input_presets?.length ?? 0
              const attachmentCount = (item.input_presets ?? []).reduce(
                (count, preset) => count + (preset.source_attachment_ids?.length ?? 0),
                0
              )

              return (
                <div
                  key={`${item.id}-${index}`}
                  className="flex flex-col gap-3 rounded-md border border-border bg-base px-4 py-3 md:flex-row md:items-center md:justify-between"
                  data-testid={`quick-launch-function-card-${index}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-sm font-medium text-text-primary">
                        {item.title || t('system_config.quick_launch_function_untitled')}
                      </h4>
                      {!item.enabled && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-xs text-text-muted">
                          {t('system_config.quick_launch_function_disabled')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-text-muted">
                      {item.id} - {team?.display_name || team?.name || item.team_id} - {presetCount}{' '}
                      {t('system_config.quick_launch_function_presets')} - {attachmentCount}{' '}
                      {t('system_config.quick_launch_function_preset_attachments')}
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Switch
                      checked={item.enabled}
                      onCheckedChange={checked =>
                        updateQuickLaunchFunction(index, { enabled: checked })
                      }
                      data-testid={`quick-launch-function-list-enabled-${index}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 min-w-[44px]"
                      onClick={() => setEditingQuickLaunchFunctionIndex(index)}
                      data-testid={`edit-quick-launch-function-${index}`}
                    >
                      <PencilIcon className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 min-w-[44px] text-red-500 hover:text-red-600"
                      onClick={() => removeQuickLaunchFunction(index)}
                      data-testid={`remove-quick-launch-function-${index}`}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </Card>

      {editingQuickLaunchFunction && editingQuickLaunchFunctionIndex !== null && (
        <Dialog
          open={true}
          onOpenChange={open => {
            if (!open) {
              setEditingQuickLaunchFunctionIndex(null)
            }
          }}
        >
          <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingQuickLaunchFunction.title ||
                  t('system_config.quick_launch_function_untitled')}
              </DialogTitle>
              <DialogDescription>
                {t('system_config.quick_launch_functions_description')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`quick-launch-function-id-${editingQuickLaunchFunctionIndex}`}>
                    {t('system_config.quick_launch_function_id')}
                  </Label>
                  <Input
                    id={`quick-launch-function-id-${editingQuickLaunchFunctionIndex}`}
                    value={editingQuickLaunchFunction.id}
                    onChange={event =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        id: event.target.value,
                      })
                    }
                    data-testid={`quick-launch-function-id-${editingQuickLaunchFunctionIndex}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`quick-launch-function-title-${editingQuickLaunchFunctionIndex}`}>
                    {t('system_config.quick_launch_function_title')}
                  </Label>
                  <Input
                    id={`quick-launch-function-title-${editingQuickLaunchFunctionIndex}`}
                    value={editingQuickLaunchFunction.title}
                    onChange={event =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        title: event.target.value,
                      })
                    }
                    data-testid={`quick-launch-function-title-${editingQuickLaunchFunctionIndex}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`quick-launch-function-team-${editingQuickLaunchFunctionIndex}`}>
                    {t('system_config.quick_launch_function_team')}
                  </Label>
                  <select
                    id={`quick-launch-function-team-${editingQuickLaunchFunctionIndex}`}
                    value={editingQuickLaunchFunction.team_id || ''}
                    onChange={event =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        team_id: Number(event.target.value),
                      })
                    }
                    className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    data-testid={`quick-launch-function-team-${editingQuickLaunchFunctionIndex}`}
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
                  <Label htmlFor={`quick-launch-function-order-${editingQuickLaunchFunctionIndex}`}>
                    {t('system_config.quick_launch_function_order')}
                  </Label>
                  <Input
                    id={`quick-launch-function-order-${editingQuickLaunchFunctionIndex}`}
                    type="number"
                    value={editingQuickLaunchFunction.order}
                    onChange={event =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        order: Number(event.target.value),
                      })
                    }
                    data-testid={`quick-launch-function-order-${editingQuickLaunchFunctionIndex}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`quick-launch-function-icon-${editingQuickLaunchFunctionIndex}`}>
                    {t('system_config.quick_launch_function_icon')}
                  </Label>
                  <Input
                    id={`quick-launch-function-icon-${editingQuickLaunchFunctionIndex}`}
                    value={editingQuickLaunchFunction.icon || ''}
                    onChange={event =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        icon: event.target.value,
                      })
                    }
                    data-testid={`quick-launch-function-icon-${editingQuickLaunchFunctionIndex}`}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <Label
                    htmlFor={`quick-launch-function-enabled-${editingQuickLaunchFunctionIndex}`}
                  >
                    {t('system_config.quick_launch_function_enabled')}
                  </Label>
                  <Switch
                    id={`quick-launch-function-enabled-${editingQuickLaunchFunctionIndex}`}
                    checked={editingQuickLaunchFunction.enabled}
                    onCheckedChange={checked =>
                      updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                        enabled: checked,
                      })
                    }
                    data-testid={`quick-launch-function-enabled-${editingQuickLaunchFunctionIndex}`}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor={`quick-launch-function-description-${editingQuickLaunchFunctionIndex}`}
                >
                  {t('system_config.quick_launch_function_description')}
                </Label>
                <Textarea
                  id={`quick-launch-function-description-${editingQuickLaunchFunctionIndex}`}
                  value={editingQuickLaunchFunction.description || ''}
                  onChange={event =>
                    updateQuickLaunchFunction(editingQuickLaunchFunctionIndex, {
                      description: event.target.value,
                    })
                  }
                  rows={2}
                  data-testid={`quick-launch-function-description-${editingQuickLaunchFunctionIndex}`}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>{t('system_config.quick_launch_function_presets')}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-11 min-w-[44px]"
                    onClick={() => addQuickLaunchPreset(editingQuickLaunchFunctionIndex)}
                    disabled={(editingQuickLaunchFunction.input_presets ?? []).length >= 6}
                    data-testid={`add-quick-launch-function-preset-${editingQuickLaunchFunctionIndex}`}
                  >
                    <PlusIcon className="h-4 w-4" />
                    {t('system_config.quick_launch_function_add_preset')}
                  </Button>
                </div>
                <div className="space-y-3">
                  {getEditableInputPresets(editingQuickLaunchFunction).map(
                    (preset, presetIndex) => {
                      const uploadKey = `${editingQuickLaunchFunctionIndex}-${presetIndex}`
                      const isUploading = uploadingQuickLaunchPresetKey === uploadKey

                      return (
                        <div
                          key={`${preset.id}-${presetIndex}`}
                          className="space-y-3 rounded-md border border-border bg-surface p-3"
                          data-testid={`quick-launch-function-preset-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                        >
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label
                                htmlFor={`quick-launch-function-preset-title-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {t('system_config.quick_launch_function_preset_title')}
                              </Label>
                              <Input
                                id={`quick-launch-function-preset-title-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                value={preset.title}
                                maxLength={120}
                                onChange={event =>
                                  updateQuickLaunchPreset(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    {
                                      title: event.target.value,
                                    }
                                  )
                                }
                                placeholder={t(
                                  'system_config.quick_launch_function_preset_title_placeholder'
                                )}
                                data-testid={`quick-launch-function-preset-title-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label
                                htmlFor={`quick-launch-function-preset-skills-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {t('system_config.quick_launch_function_preset_skills')}
                              </Label>
                              <Input
                                id={`quick-launch-function-preset-skills-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                value={(preset.options?.selected_skill_names ?? []).join(', ')}
                                onChange={event =>
                                  updateQuickLaunchPresetOptions(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    {
                                      selected_skill_names: event.target.value
                                        .split(',')
                                        .map(name => name.trim())
                                        .filter(Boolean),
                                    }
                                  )
                                }
                                placeholder={t(
                                  'system_config.quick_launch_function_preset_skills_placeholder'
                                )}
                                data-testid={`quick-launch-function-preset-skills-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label
                              htmlFor={`quick-launch-function-preset-prompt-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                            >
                              {t('system_config.quick_launch_function_preset_prompt')}
                            </Label>
                            <Textarea
                              id={`quick-launch-function-preset-prompt-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              value={preset.prompt || ''}
                              maxLength={2000}
                              rows={3}
                              onChange={event =>
                                updateQuickLaunchPreset(
                                  editingQuickLaunchFunctionIndex,
                                  presetIndex,
                                  {
                                    prompt: event.target.value,
                                  }
                                )
                              }
                              placeholder={t(
                                'system_config.quick_launch_function_preset_prompt_placeholder'
                              )}
                              data-testid={`quick-launch-function-preset-prompt-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                            />
                          </div>

                          <div className="rounded-md border border-border bg-base p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Label>
                                {t('system_config.quick_launch_function_preset_attachments')}
                              </Label>
                              <input
                                id={`quick-launch-function-preset-attachment-input-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                type="file"
                                className="hidden"
                                onChange={event => {
                                  void handleQuickLaunchPresetUpload(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    event.target.files
                                  )
                                  event.currentTarget.value = ''
                                }}
                                data-testid={`quick-launch-function-preset-attachment-input-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-11 min-w-[44px]"
                                disabled={isUploading}
                                onClick={() =>
                                  document
                                    .getElementById(
                                      `quick-launch-function-preset-attachment-input-${editingQuickLaunchFunctionIndex}-${presetIndex}`
                                    )
                                    ?.click()
                                }
                                data-testid={`quick-launch-function-preset-upload-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {isUploading ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Upload className="h-4 w-4" />
                                )}
                                {t('system_config.quick_launch_function_preset_upload_attachment')}
                              </Button>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(preset.source_attachment_ids ?? []).length === 0 ? (
                                <span className="text-xs text-text-muted">
                                  {t('system_config.quick_launch_function_preset_no_attachments')}
                                </span>
                              ) : (
                                (preset.source_attachment_ids ?? []).map(attachmentId => (
                                  <span
                                    key={attachmentId}
                                    className="inline-flex min-h-8 max-w-full items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary"
                                  >
                                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                                    <span className="truncate">
                                      {quickLaunchAttachmentLabels[attachmentId] ??
                                        `#${attachmentId}`}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 min-w-7 text-text-muted hover:text-red-600"
                                      onClick={() =>
                                        removeQuickLaunchPresetAttachment(
                                          editingQuickLaunchFunctionIndex,
                                          presetIndex,
                                          attachmentId
                                        )
                                      }
                                      data-testid={`remove-quick-launch-function-preset-attachment-${editingQuickLaunchFunctionIndex}-${presetIndex}-${attachmentId}`}
                                    >
                                      <TrashIcon className="h-3.5 w-3.5" />
                                    </Button>
                                  </span>
                                ))
                              )}
                            </div>
                          </div>

                          <div className="grid gap-2 md:grid-cols-3">
                            <div className="flex items-center justify-between rounded-md border border-border bg-base px-3 py-2">
                              <Label
                                htmlFor={`quick-launch-function-preset-deep-thinking-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {t('system_config.quick_launch_function_preset_deep_thinking')}
                              </Label>
                              <Switch
                                id={`quick-launch-function-preset-deep-thinking-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                checked={preset.options?.enable_deep_thinking ?? false}
                                onCheckedChange={checked =>
                                  updateQuickLaunchPresetOptions(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    {
                                      enable_deep_thinking: checked,
                                    }
                                  )
                                }
                                data-testid={`quick-launch-function-preset-deep-thinking-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                            </div>
                            <div className="flex items-center justify-between rounded-md border border-border bg-base px-3 py-2">
                              <Label
                                htmlFor={`quick-launch-function-preset-clarification-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {t('system_config.quick_launch_function_preset_clarification')}
                              </Label>
                              <Switch
                                id={`quick-launch-function-preset-clarification-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                checked={preset.options?.enable_clarification ?? false}
                                onCheckedChange={checked =>
                                  updateQuickLaunchPresetOptions(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    {
                                      enable_clarification: checked,
                                    }
                                  )
                                }
                                data-testid={`quick-launch-function-preset-clarification-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                            </div>
                            <div className="flex items-center justify-between rounded-md border border-border bg-base px-3 py-2">
                              <Label
                                htmlFor={`quick-launch-function-preset-force-override-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              >
                                {t('system_config.quick_launch_function_preset_force_override')}
                              </Label>
                              <Switch
                                id={`quick-launch-function-preset-force-override-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                                checked={preset.options?.force_override ?? false}
                                onCheckedChange={checked =>
                                  updateQuickLaunchPresetOptions(
                                    editingQuickLaunchFunctionIndex,
                                    presetIndex,
                                    {
                                      force_override: checked,
                                    }
                                  )
                                }
                                data-testid={`quick-launch-function-preset-force-override-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                              />
                            </div>
                          </div>

                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-11 min-w-[44px] shrink-0 text-text-muted hover:text-text-primary"
                              onClick={() =>
                                removeQuickLaunchPreset(
                                  editingQuickLaunchFunctionIndex,
                                  presetIndex
                                )
                              }
                              data-testid={`remove-quick-launch-function-preset-${editingQuickLaunchFunctionIndex}-${presetIndex}`}
                            >
                              <TrashIcon className="h-4 w-4" />
                              {t('common:actions.delete')}
                            </Button>
                          </div>
                        </div>
                      )
                    }
                  )}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="primary"
                onClick={() => setEditingQuickLaunchFunctionIndex(null)}
                data-testid="quick-launch-function-editor-done"
              >
                {t('common.done')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

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
