// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetSettings component
 *
 * Settings panel for pet configuration in the user settings page.
 */

import React, { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { usePet } from '@/features/pet/contexts/PetContext'
import { PetAvatar } from './PetAvatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { STAGE_NAMES } from '@/features/pet/types/pet'
import { Loader2, RotateCcw, Save } from 'lucide-react'

export function PetSettings() {
  const { t } = useTranslation('pet')
  const { pet, isLoading, updatePet, resetPet } = usePet()

  const [petName, setPetName] = useState(pet?.pet_name || '')
  const [isVisible, setIsVisible] = useState(pet?.is_visible ?? true)
  const [isSaving, setIsSaving] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const trimmedName = petName.trim()

  // Sync state when pet data changes
  React.useEffect(() => {
    if (pet) {
      setPetName(pet.pet_name)
      setIsVisible(pet.is_visible)
    }
  }, [pet])

  const handleSave = async () => {
    if (!pet) return
    if (!trimmedName) return
    setIsSaving(true)
    try {
      await updatePet({
        pet_name: trimmedName !== pet.pet_name ? trimmedName : undefined,
        is_visible: isVisible !== pet.is_visible ? isVisible : undefined,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = async () => {
    setIsResetting(true)
    try {
      await resetPet()
    } finally {
      setIsResetting(false)
    }
  }

  const hasChanges = pet && (trimmedName !== pet.pet_name || isVisible !== pet.is_visible)

  if (isLoading && !pet) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
      </div>
    )
  }

  if (!pet) {
    return <div className="text-center py-12 text-text-secondary">{t('settings.no_pet')}</div>
  }

  const stageName = STAGE_NAMES[pet.stage]

  return (
    <div className="space-y-6">
      {/* Pet preview */}
      <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
        <div className="shrink-0">
          <PetAvatar pet={pet} animationState="idle" />
        </div>

        <div className="flex-1 space-y-4 w-full">
          {/* Pet name input */}
          <div className="space-y-2">
            <Label htmlFor="pet-name">{t('settings.name')}</Label>
            <Input
              id="pet-name"
              value={petName}
              onChange={e => setPetName(e.target.value)}
              maxLength={50}
              placeholder={t('settings.name_placeholder')}
            />
          </div>

          {/* Visibility toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="pet-visible">{t('settings.enable')}</Label>
            <Switch id="pet-visible" checked={isVisible} onCheckedChange={setIsVisible} />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 bg-surface rounded-lg">
        <div className="text-center">
          <div className="text-2xl font-bold text-primary">{pet.experience}</div>
          <div className="text-xs text-text-secondary">{t('stats.experience')}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-text-primary">{t(`stages.${stageName}`)}</div>
          <div className="text-xs text-text-secondary">{t('stats.stage')}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-text-primary">{pet.total_chats}</div>
          <div className="text-xs text-text-secondary">{t('stats.chats')}</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-text-primary">{pet.current_streak}</div>
          <div className="text-xs text-text-secondary">{t('stats.streak')}</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={handleSave} disabled={!hasChanges || isSaving} className="flex-1">
          {isSaving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {t('settings.save')}
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="flex-1 sm:flex-none">
              <RotateCcw className="w-4 h-4 mr-2" />
              {t('settings.reset')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.reset')}</AlertDialogTitle>
              <AlertDialogDescription>{t('settings.reset_confirm')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleReset} disabled={isResetting}>
                {isResetting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {t('settings.reset')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
