// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TEAM_ICONS, getTeamIconById, DEFAULT_TEAM_ICON_ID } from '../../constants/team-icons'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

interface TeamIconPickerProps {
  value: string | null | undefined
  onChange: (iconId: string | null) => void
  onUploadImage?: (file: File) => Promise<string>
  disabled?: boolean
}

const MAX_ICON_FILE_SIZE = 2 * 1024 * 1024
const SUPPORTED_ICON_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function isCustomImage(value: string | null | undefined): value is string {
  return Boolean(
    value && (value.startsWith('/') || value.startsWith('https://') || value.startsWith('http://'))
  )
}

/**
 * Icon picker component for selecting team icons
 * Shows preset icons and an optional custom image uploader.
 */
export function TeamIconPicker({
  value,
  onChange,
  onUploadImage,
  disabled = false,
}: TeamIconPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selectedIcon = getTeamIconById(value || DEFAULT_TEAM_ICON_ID)
  const SelectedIconComponent = selectedIcon.icon
  const customImage = isCustomImage(value)

  const handleSelectIcon = (iconId: string) => {
    onChange(iconId)
    setOpen(false)
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !onUploadImage) return
    if (!SUPPORTED_ICON_TYPES.has(file.type) || file.size > MAX_ICON_FILE_SIZE) {
      setUploadError(t('common:teams.customIconInvalid'))
      return
    }

    setUploading(true)
    setUploadError(null)
    try {
      onChange(await onUploadImage(file))
      setOpen(false)
    } catch {
      setUploadError(t('common:teams.customIconUploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="team-icon-picker-trigger"
          className={`
            flex items-center justify-center h-11 w-11 sm:w-10 sm:h-10 rounded-lg border border-border
            bg-base hover:bg-hover transition-colors
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          `}
          title={t('common:teams.icon')}
        >
          {customImage ? (
            // Public-team icon URLs are administrator-uploaded assets.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="h-full w-full rounded-lg object-cover" />
          ) : (
            <SelectedIconComponent className="w-5 h-5 text-primary" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[332px] max-w-[calc(100vw-2rem)] p-3 sm:w-[368px]"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <div className="space-y-2">
          <div className="text-sm font-medium text-text-primary">
            {t('common:teams.selectIcon')}
          </div>
          {onUploadImage && (
            <div className="space-y-2 rounded-lg border border-border p-2.5">
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleUpload}
                data-testid="team-icon-image-input"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-11 flex-1 md:h-9"
                  disabled={uploading}
                  onClick={() => inputRef.current?.click()}
                  data-testid="team-icon-upload-button"
                >
                  {uploading ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="mr-1.5 h-4 w-4" />
                  )}
                  {t('common:teams.uploadCustomIcon')}
                </Button>
                {customImage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 min-w-11 md:h-10 md:w-10 md:min-w-10"
                    onClick={() => onChange(null)}
                    title={t('common:teams.removeCustomIcon')}
                    data-testid="team-icon-remove-button"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-text-muted">{t('common:teams.customIconHint')}</p>
              {uploadError && (
                <p className="text-xs text-red-500" role="alert">
                  {uploadError}
                </p>
              )}
            </div>
          )}
          <div className="grid max-h-[320px] grid-cols-5 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-8">
            {TEAM_ICONS.map(iconConfig => {
              const IconComponent = iconConfig.icon
              const isSelected = iconConfig.id === (value || DEFAULT_TEAM_ICON_ID)

              return (
                <button
                  key={iconConfig.id}
                  type="button"
                  onClick={() => handleSelectIcon(iconConfig.id)}
                  data-testid={`team-icon-option-${iconConfig.id}`}
                  className={`
                    flex items-center justify-center h-11 w-11 rounded-md transition-colors sm:h-9 sm:w-9
                    ${
                      isSelected
                        ? 'bg-primary text-white'
                        : 'bg-surface hover:bg-hover text-text-secondary hover:text-text-primary'
                    }
                  `}
                  title={iconConfig.label}
                >
                  <IconComponent className="w-5 h-5" />
                </button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
