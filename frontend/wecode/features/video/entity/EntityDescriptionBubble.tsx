// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { SingleDescriptionInput } from '@wecode/features/video/components/SingleDescriptionInput'
import { useTranslation } from '@/hooks/useTranslation'

interface EntityDescriptionBubbleProps {
  description: string
  isEditing: boolean
  activeIndex?: number
  thumbWidth?: number
  maxLength?: number
  width?: number
  showMaxLength?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onCancel?: () => void
}

export function EntityDescriptionBubble({
  description,
  isEditing,
  maxLength = 200,
  width = 640,
  showMaxLength = true,
  onChange,
  onSave,
  onCancel,
}: EntityDescriptionBubbleProps) {
  const { t } = useTranslation('video')

  return (
    <div className="relative">
      <SingleDescriptionInput
        value={description}
        isEditing={isEditing}
        maxLength={maxLength}
        width={width}
        showButtons={isEditing}
        showMaxLength={showMaxLength}
        useGradientBorder={true}
        placeholder={t('enter_description')}
        onChange={onChange}
        onSave={onSave}
        onCancel={onCancel}
      />
    </div>
  )
}
