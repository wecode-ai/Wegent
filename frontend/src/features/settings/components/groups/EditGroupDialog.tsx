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
import { updateGroup } from '@/apis/groups'
import { toast } from 'sonner'
import type { Group, GroupUpdate, GroupVisibility } from '@/types/group'

interface EditGroupDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  group: Group | null
}

export function EditGroupDialog({ isOpen, onClose, onSuccess, group }: EditGroupDialogProps) {
  const { t } = useTranslation()
  const [formData, setFormData] = useState<GroupUpdate>({
    display_name: '',
    visibility: 'private',
    description: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen && group) {
      setFormData({
        display_name: group.display_name || '',
        visibility: group.visibility,
        description: group.description || '',
      })
    }
  }, [isOpen, group])

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (formData.display_name && formData.display_name.length > 100) {
      newErrors.display_name = t('common:validation.max_length', { max: 100 })
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!group || !validateForm()) {
      return
    }

    setIsSubmitting(true)
    try {
      const payload: GroupUpdate = {
        display_name: formData.display_name?.trim() || undefined,
        visibility: formData.visibility,
        description: formData.description?.trim() || undefined,
      }

      await updateGroup(group.name, payload)
      toast.success(t('groups:groups.messages.updateSuccess'))

      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to update group:', error)
      const err = error as { response?: { data?: { detail?: string } }; message?: string }
      const errorMessage = err?.response?.data?.detail || err?.message || 'Failed to update group'
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (!isSubmitting) {
      setErrors({})
      onClose()
    }
  }

  if (!group) {
    return null
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('common:actions.edit_group')}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name (read-only) */}
        <div>
          <Label htmlFor="name">{t('groups:groups.name')}</Label>
          <Input id="name" value={group.name} disabled className="bg-muted" />
          <p className="text-xs text-text-muted mt-1">{t('groups:groupCreate.nameImmutable')}</p>
        </div>

        {/* Display Name */}
        <div>
          <Label htmlFor="display_name">{t('groups:groups.displayName')}</Label>
          <Input
            id="display_name"
            value={formData.display_name}
            onChange={e => {
              const value = e.target.value
              setFormData(prev => ({ ...prev, display_name: value }))
              if (errors.display_name) {
                setErrors(prev => ({ ...prev, display_name: '' }))
              }
            }}
            placeholder="My Group"
            disabled={isSubmitting}
            className={errors.display_name ? 'border-error' : ''}
          />
          {errors.display_name && <p className="text-sm text-error mt-1">{errors.display_name}</p>}
        </div>

        {/* Visibility */}
        <div>
          <Label htmlFor="visibility">{t('groups:groups.visibility')}</Label>
          <Select
            value={formData.visibility}
            onValueChange={(value: GroupVisibility) => {
              // Prevent setting empty value (Radix Select may trigger this unexpectedly)
              if (value) {
                setFormData(prev => ({ ...prev, visibility: value }))
              }
            }}
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
            onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
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
                {t('common:actions.saving')}
              </div>
            ) : (
              t('common:actions.save')
            )}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
