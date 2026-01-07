// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
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
  ChatSloganItem,
  ChatTipItem,
  ChatSloganTipsResponse,
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

const SystemConfigPanel: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()

  // State
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [slogans, setSlogans] = useState<ChatSloganItem[]>([])
  const [tips, setTips] = useState<ChatTipItem[]>([])
  const [version, setVersion] = useState(0)

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
      const response: ChatSloganTipsResponse = await adminApis.getSloganTipsConfig()
      setSlogans(response.slogans)
      setTips(response.tips)
      setVersion(response.version)
    } catch (error) {
      console.error('Failed to fetch slogan tips config:', error)
      toast({
        title: t('admin:system_config.errors.load_failed'),
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
    setSaving(true)
    try {
      const response = await adminApis.updateSloganTipsConfig({
        slogans,
        tips,
      })
      setVersion(response.version)
      toast({
        title: t('admin:system_config.success.updated'),
      })
    } catch (error) {
      console.error('Failed to save slogan tips config:', error)
      toast({
        title: t('admin:system_config.errors.save_failed'),
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
        title: t('admin:system_config.errors.slogan_required'),
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
        title: t('admin:system_config.errors.tip_required'),
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

  // ==================== Render ====================

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-text-muted">{t('admin:system_config.loading')}</span>
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
                  {t(`admin:system_config.mode_${item.mode || 'both'}`)}
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
          <DialogDescription>{t('admin:system_config.dialog_description')}</DialogDescription>
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
            <Label htmlFor="item-mode">{t('admin:system_config.mode')}</Label>
            <Select
              value={formData.mode || 'both'}
              onValueChange={(value: SloganTipMode) => setFormData({ ...formData, mode: value })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t('admin:system_config.mode')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">{t('admin:system_config.mode_chat')}</SelectItem>
                <SelectItem value="code">{t('admin:system_config.mode_code')}</SelectItem>
                <SelectItem value="both">{t('admin:system_config.mode_both')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('admin:common.cancel')}
          </Button>
          <Button onClick={onSave}>{t('admin:common.save')}</Button>
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
          <AlertDialogCancel>{t('admin:common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('admin:common.delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            {t('admin:system_config.title')}
          </h2>
          <p className="text-sm text-text-muted">{t('admin:system_config.description')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('admin:common.save')}
        </Button>
      </div>

      {/* Slogan Configuration */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-text-primary">
            {t('admin:system_config.slogan_title')}
          </h3>
          <Button variant="outline" size="sm" onClick={handleAddSlogan}>
            <PlusIcon className="h-4 w-4 mr-1" />
            {t('admin:system_config.add_slogan')}
          </Button>
        </div>
        {renderItemList(
          slogans,
          handleEditSlogan as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          handleDeleteSloganClick as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          t('admin:system_config.no_slogans')
        )}
      </Card>

      {/* Tips Configuration */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-text-primary">
            {t('admin:system_config.tips_title')}
          </h3>
          <Button variant="outline" size="sm" onClick={handleAddTip}>
            <PlusIcon className="h-4 w-4 mr-1" />
            {t('admin:system_config.add_tip')}
          </Button>
        </div>
        {renderItemList(
          tips,
          handleEditTip as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          handleDeleteTipClick as (item: ChatSloganItem | ChatTipItem, index: number) => void,
          t('admin:system_config.no_tips')
        )}
      </Card>

      {/* Version Info */}
      <div className="text-xs text-text-muted text-right">
        {t('admin:system_config.version')}: {version}
      </div>

      {/* Slogan Dialogs */}
      {renderEditDialog(
        isSloganDialogOpen,
        setIsSloganDialogOpen,
        editingSlogan ? t('admin:system_config.edit_slogan') : t('admin:system_config.add_slogan'),
        sloganFormData,
        setSloganFormData,
        handleSaveSlogan,
        t('admin:system_config.slogan_zh'),
        t('admin:system_config.slogan_zh_placeholder'),
        t('admin:system_config.slogan_en'),
        t('admin:system_config.slogan_en_placeholder')
      )}
      {renderDeleteDialog(
        isDeleteSloganDialogOpen,
        setIsDeleteSloganDialogOpen,
        t('admin:system_config.delete_slogan_title'),
        t('admin:system_config.delete_slogan_message'),
        handleConfirmDeleteSlogan
      )}

      {/* Tip Dialogs */}
      {renderEditDialog(
        isTipDialogOpen,
        setIsTipDialogOpen,
        editingTip ? t('admin:system_config.edit_tip') : t('admin:system_config.add_tip'),
        tipFormData,
        setTipFormData,
        handleSaveTip,
        t('admin:system_config.tip_zh'),
        t('admin:system_config.tip_zh_placeholder'),
        t('admin:system_config.tip_en'),
        t('admin:system_config.tip_en_placeholder')
      )}
      {renderDeleteDialog(
        isDeleteTipDialogOpen,
        setIsDeleteTipDialogOpen,
        t('admin:system_config.delete_tip_title'),
        t('admin:system_config.delete_tip_message'),
        handleConfirmDeleteTip
      )}
    </div>
  )
}

export default SystemConfigPanel
