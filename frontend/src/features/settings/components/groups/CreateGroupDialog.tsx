// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import Modal from '@/features/common/Modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createGroup, listGroups } from '@/apis/groups'
import { toast } from 'sonner'
import type { GroupCreate, Group, GroupVisibility } from '@/types/group'

interface CreateGroupDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function CreateGroupDialog({ isOpen, onClose, onSuccess }: CreateGroupDialogProps) {
  const { t } = useTranslation()
  const [formData, setFormData] = useState<GroupCreate>({
    name: '',
    display_name: '',
    visibility: 'internal',
    description: '',
  })
  const [parentGroup, setParentGroup] = useState<string>('__none__')
  const [availableGroups, setAvailableGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Load available groups when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadAvailableGroups()
    }
  }, [isOpen])

  const loadAvailableGroups = async () => {
    try {
      setLoadingGroups(true)
      const response = await listGroups({ page: 1, limit: 100 })
      // Filter groups that can be parent (max nesting level is 5)
      const eligibleGroups = (response.items || []).filter(group => {
        const depth = group.name.split('groups:/').length
        return depth < 5 // Can only be parent if depth < 5
      })
      setAvailableGroups(eligibleGroups)
    } catch (error) {
      console.error('Failed to load groups:', error)
    } finally {
      setLoadingGroups(false)
    }
  }

  const validateName = (name: string): string | null => {
    if (!name) {
      return t('common:validation.required')
    }
    if (name.length > 100) {
      return t('common:validation.max_length', { max: 100 })
    }
    // Check if name starts with "default" (case-insensitive)
    if (name.toLowerCase().startsWith('default')) {
      return t('groups:groupCreate.nameCannotStartWithDefault')
    }
    // Name must be alphanumeric with dashes/underscores, no spaces
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return t('groups:groupCreate.nameValidation')
    }
    return null
  }

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    const nameError = validateName(formData.name)
    if (nameError) {
      newErrors.name = nameError
    }

    if (formData.display_name && formData.display_name.length > 100) {
      newErrors.display_name = t('common:validation.max_length', { max: 100 })
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setIsSubmitting(true)
    try {
      // Construct the final group name
      const baseName = formData.name.trim()
      const finalName =
        parentGroup && parentGroup !== '__none__' ? `${parentGroup}/${baseName}` : baseName

      const payload: GroupCreate = {
        name: finalName,
        display_name: formData.display_name?.trim() || baseName,
        visibility: formData.visibility,
        description: formData.description?.trim() || undefined,
      }

      await createGroup(payload)
      toast.success(t('groups:groups.messages.createSuccess'))

      // Reset form
      setFormData({
        name: '',
        display_name: '',
        visibility: 'internal',
        description: '',
      })
      setParentGroup('__none__')
      setErrors({})
      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to create group:', error)
      const err = error as { response?: { data?: { detail?: string } }; message?: string }
      const errorMessage = err?.response?.data?.detail || err?.message || 'Failed to create group'
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (!isSubmitting) {
      setFormData({
        name: '',
        display_name: '',
        visibility: 'internal',
        description: '',
      })
      setParentGroup('__none__')
      setErrors({})
      onClose()
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={t('groups:groups.create')} maxWidth="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <Label htmlFor="name">
            {t('groups:groups.name')} <span className="text-error">*</span>
          </Label>
          <Input
            id="name"
            value={formData.name}
            onChange={e => {
              setFormData({ ...formData, name: e.target.value })
              if (errors.name) {
                setErrors({ ...errors, name: '' })
              }
            }}
            placeholder={t('groups:groupCreate.namePlaceholder')}
            disabled={isSubmitting}
            className={errors.name ? 'border-error' : ''}
          />
          {errors.name && <p className="text-sm text-error mt-1">{errors.name}</p>}
          <p className="text-xs text-text-muted mt-1">
            {parentGroup && parentGroup !== '__none__'
              ? t('groups:groupCreate.finalNameWillBe', { name: `${parentGroup}/${formData.name}` })
              : t('groups:groupCreate.nameImmutable')}
          </p>
        </div>

        {/* Display Name */}
        <div>
          <Label htmlFor="display_name">{t('groups:groups.displayName')}</Label>
          <Input
            id="display_name"
            value={formData.display_name}
            onChange={e => {
              setFormData({ ...formData, display_name: e.target.value })
              if (errors.display_name) {
                setErrors({ ...errors, display_name: '' })
              }
            }}
            placeholder={t('groups:groupCreate.displayNamePlaceholder')}
            disabled={isSubmitting}
            className={errors.display_name ? 'border-error' : ''}
          />
          {errors.display_name && <p className="text-sm text-error mt-1">{errors.display_name}</p>}
        </div>

        {/* Parent Group */}
        <div>
          <Label htmlFor="parent_group">{t('groups:groupCreate.parentGroup')}</Label>
          <Select
            value={parentGroup}
            onValueChange={setParentGroup}
            disabled={isSubmitting || loadingGroups}
          >
            <SelectTrigger id="parent_group">
              <SelectValue placeholder={t('groups:groupCreate.noParentGroup')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('groups:groupCreate.noParentGroup')}</SelectItem>
              {availableGroups.map(group => (
                <SelectItem key={group.id} value={group.name}>
                  {group.display_name || group.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted mt-1">{t('groups:groupCreate.parentGroupHint')}</p>
        </div>

        {/* Visibility */}
        <div>
          <Label htmlFor="visibility">{t('groups:groups.visibility')}</Label>
          <Select
            value={formData.visibility}
            onValueChange={(value: GroupVisibility) =>
              setFormData({ ...formData, visibility: value })
            }
            disabled={isSubmitting}
          >
            <SelectTrigger id="visibility" data-testid="visibility-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">
                <div className="flex flex-col">
                  <span>{t('groups:groups.internal')}</span>
                </div>
              </SelectItem>
              <SelectItem value="public">
                <div className="flex flex-col">
                  <span>{t('groups:groups.public')}</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted mt-1">
            {formData.visibility === 'public' && t('groups:groupCreate.visibilityPublicHint')}
            {formData.visibility === 'internal' && t('groups:groupCreate.visibilityInternalHint')}
          </p>
        </div>

        {/* Description */}
        <div>
          <Label htmlFor="description">{t('groups:groups.description')}</Label>
          <Textarea
            id="description"
            value={formData.description}
            onChange={e => setFormData({ ...formData, description: e.target.value })}
            placeholder={t('groups:groupCreate.descriptionPlaceholder')}
            rows={3}
            disabled={isSubmitting}
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {t('common:actions.creating')}
              </div>
            ) : (
              t('groups:groups.create')
            )}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
