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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  adminApis,
  AdminTemplate,
  AdminTemplateCreate,
  AdminTemplateUpdate,
  TemplateResources,
} from '@/apis/admin'
import { useToast } from '@/hooks/use-toast'

interface TemplateEditDialogProps {
  open: boolean
  onClose: () => void
  editingTemplate: AdminTemplate | null
  onSuccess: () => void
}

const DEFAULT_RESOURCES: TemplateResources = {
  ghost: {
    systemPrompt: '',
  },
  bot: {
    shellName: 'Chat',
  },
  team: {
    collaborationModel: 'pipeline',
  },
  subscription: {
    promptTemplate: '{{inbox_message}}',
    retryCount: 1,
    timeoutSeconds: 300,
  },
  queue: {
    visibility: 'private',
    triggerMode: 'immediate',
  },
}

const TemplateEditDialog: React.FC<TemplateEditDialogProps> = ({
  open,
  onClose,
  editingTemplate,
  onSuccess,
}) => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('basic')

  // Basic fields
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('inbox')
  const [icon, setIcon] = useState('')
  const [tagsInput, setTagsInput] = useState('')

  // Resources JSON editor
  const [resourcesJson, setResourcesJson] = useState('')
  const [resourcesJsonError, setResourcesJsonError] = useState('')

  const isEditing = !!editingTemplate

  // Initialize form when dialog opens or editingTemplate changes
  useEffect(() => {
    if (open) {
      setActiveTab('basic')
      setResourcesJsonError('')
      if (editingTemplate) {
        setName(editingTemplate.name)
        setDisplayName(editingTemplate.displayName)
        setDescription(editingTemplate.description ?? '')
        setCategory(editingTemplate.category)
        setIcon(editingTemplate.icon ?? '')
        setTagsInput(editingTemplate.tags.join(', '))
        setResourcesJson(JSON.stringify(editingTemplate.resources, null, 2))
      } else {
        setName('')
        setDisplayName('')
        setDescription('')
        setCategory('inbox')
        setIcon('')
        setTagsInput('')
        setResourcesJson(JSON.stringify(DEFAULT_RESOURCES, null, 2))
      }
    }
  }, [open, editingTemplate])

  const parseTags = (input: string): string[] => {
    return input
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0)
  }

  const validateResourcesJson = (): TemplateResources | null => {
    try {
      const parsed = JSON.parse(resourcesJson)
      setResourcesJsonError('')
      return parsed as TemplateResources
    } catch {
      setResourcesJsonError(t('templates.errors.resources_invalid_json'))
      return null
    }
  }

  const handleSave = async () => {
    // Validate basic fields
    if (!displayName.trim()) {
      toast({
        variant: 'destructive',
        title: t('templates.errors.display_name_required'),
      })
      return
    }

    if (!isEditing && !name.trim()) {
      toast({
        variant: 'destructive',
        title: t('templates.errors.name_required'),
      })
      return
    }

    // Validate resources JSON
    const resources = validateResourcesJson()
    if (!resources) {
      setActiveTab('resources')
      return
    }

    setSaving(true)
    try {
      if (isEditing && editingTemplate) {
        const updateData: AdminTemplateUpdate = {
          displayName: displayName.trim(),
          description: description.trim() || undefined,
          category,
          tags: parseTags(tagsInput),
          icon: icon.trim() || undefined,
          resources,
        }
        await adminApis.updateTemplate(editingTemplate.id, updateData)
        toast({ title: t('templates.success.updated') })
      } else {
        const createData: AdminTemplateCreate = {
          name: name.trim(),
          displayName: displayName.trim(),
          description: description.trim() || undefined,
          category,
          tags: parseTags(tagsInput),
          icon: icon.trim() || undefined,
          resources,
        }
        await adminApis.createTemplate(createData)
        toast({ title: t('templates.success.created') })
      }
      onSuccess()
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing
          ? t('templates.errors.update_failed')
          : t('templates.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('templates.edit_template') : t('templates.create_template')}
          </DialogTitle>
          <DialogDescription>
            {isEditing ? t('templates.edit_description') : t('templates.create_description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="basic">{t('templates.tabs.basic')}</TabsTrigger>
            <TabsTrigger value="resources">{t('templates.tabs.resources')}</TabsTrigger>
          </TabsList>

          {/* Basic Tab */}
          <TabsContent value="basic" className="space-y-4 mt-4">
            {/* Name (only for create) */}
            {!isEditing && (
              <div className="space-y-1.5">
                <Label htmlFor="template-name">
                  {t('templates.form.name')}
                  <span className="text-error ml-1">*</span>
                </Label>
                <Input
                  id="template-name"
                  data-testid="template-name-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('templates.form.name_placeholder')}
                />
                <p className="text-xs text-text-muted">{t('templates.form.name_hint')}</p>
              </div>
            )}

            {/* Display Name */}
            <div className="space-y-1.5">
              <Label htmlFor="template-display-name">
                {t('templates.form.display_name')}
                <span className="text-error ml-1">*</span>
              </Label>
              <Input
                id="template-display-name"
                data-testid="template-display-name-input"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('templates.form.display_name_placeholder')}
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="template-description">{t('templates.form.description')}</Label>
              <Textarea
                id="template-description"
                data-testid="template-description-input"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('templates.form.description_placeholder')}
                rows={3}
              />
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <Label htmlFor="template-category">{t('templates.form.category')}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="template-category" data-testid="template-category-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inbox">{t('templates.categories.inbox')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Icon */}
            <div className="space-y-1.5">
              <Label htmlFor="template-icon">{t('templates.form.icon')}</Label>
              <Input
                id="template-icon"
                data-testid="template-icon-input"
                value={icon}
                onChange={e => setIcon(e.target.value)}
                placeholder={t('templates.form.icon_placeholder')}
              />
              <p className="text-xs text-text-muted">{t('templates.form.icon_hint')}</p>
            </div>

            {/* Tags */}
            <div className="space-y-1.5">
              <Label htmlFor="template-tags">{t('templates.form.tags')}</Label>
              <Input
                id="template-tags"
                data-testid="template-tags-input"
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
                placeholder={t('templates.form.tags_placeholder')}
              />
              <p className="text-xs text-text-muted">{t('templates.form.tags_hint')}</p>
            </div>
          </TabsContent>

          {/* Resources Tab */}
          <TabsContent value="resources" className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <Label htmlFor="template-resources">{t('templates.form.resources')}</Label>
              <Textarea
                id="template-resources"
                data-testid="template-resources-input"
                value={resourcesJson}
                onChange={e => {
                  setResourcesJson(e.target.value)
                  setResourcesJsonError('')
                }}
                placeholder={t('templates.form.resources_placeholder')}
                rows={18}
                className="font-mono text-xs"
              />
              {resourcesJsonError && <p className="text-xs text-error">{resourcesJsonError}</p>}
              <p className="text-xs text-text-muted">{t('templates.form.resources_hint')}</p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} data-testid="cancel-button">
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
            data-testid="save-button"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default TemplateEditDialog
