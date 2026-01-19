// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { useProjectContext } from '../contexts/projectContext'

// Predefined colors for projects
const PROJECT_COLORS = [
  { id: 'red', value: '#EF4444' },
  { id: 'orange', value: '#F97316' },
  { id: 'yellow', value: '#EAB308' },
  { id: 'green', value: '#22C55E' },
  { id: 'blue', value: '#3B82F6' },
  { id: 'purple', value: '#8B5CF6' },
  { id: 'pink', value: '#EC4899' },
  { id: 'gray', value: '#6B7280' },
]

interface ProjectCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProjectCreateDialog({ open, onOpenChange }: ProjectCreateDialogProps) {
  const { t } = useTranslation('projects')
  const { createProject } = useProjectContext()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedColor, setSelectedColor] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return

    setIsCreating(true)
    try {
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        color: selectedColor || undefined,
      })
      // Reset form and close dialog
      setName('')
      setDescription('')
      setSelectedColor(null)
      onOpenChange(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleClose = () => {
    if (!isCreating) {
      setName('')
      setDescription('')
      setSelectedColor(null)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{t('create.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Project Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('create.nameLabel')}</Label>
            <Input
              id="name"
              placeholder={t('create.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={100}
              disabled={isCreating}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('create.descriptionLabel')}</Label>
            <Textarea
              id="description"
              placeholder={t('create.descriptionPlaceholder')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              disabled={isCreating}
            />
          </div>

          {/* Color Selection */}
          <div className="space-y-2">
            <Label>{t('create.colorLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLORS.map(color => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() =>
                    setSelectedColor(selectedColor === color.value ? null : color.value)
                  }
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    selectedColor === color.value
                      ? 'border-text-primary scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: color.value }}
                  title={t(`colors.${color.id}`)}
                  disabled={isCreating}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isCreating}>
            {t('create.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={isCreating || !name.trim()}>
            {isCreating ? t('common:actions.creating') : t('create.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
