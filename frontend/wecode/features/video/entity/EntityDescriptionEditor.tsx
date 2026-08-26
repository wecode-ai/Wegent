// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { SingleDescriptionInput } from '@wecode/features/video/components/SingleDescriptionInput'
import { useTranslation } from '@/hooks/useTranslation'

interface EntityDescriptionEditorProps {
  description: string
  voiceProfile?: string
  isEditing: boolean
  entityType?: number
  activeIndex?: number
  thumbWidth?: number
  maxLength?: number
  maxVoiceLength?: number
  onDescriptionChange?: (value: string) => void
  onVoiceProfileChange?: (value: string) => void
  onSave?: () => void
  onCancel?: () => void
}

export function EntityDescriptionEditor({
  description,
  voiceProfile = '',
  isEditing,
  entityType,
  maxLength = 200,
  maxVoiceLength = 200,
  onDescriptionChange,
  onVoiceProfileChange,
  onSave,
  onCancel,
}: EntityDescriptionEditorProps) {
  const { t } = useTranslation('video')

  // Check if current entity is a character (entity_type === 1)
  const isCharacter = entityType === 1

  // Non-character: single visual description
  if (!isCharacter) {
    return (
      <SingleDescriptionInput
        value={description}
        isEditing={isEditing}
        title={t('visual_description')}
        showTitle={true}
        maxLength={maxLength}
        width={640}
        showButtons={isEditing}
        useGradientBorder={true}
        placeholder={t('enter_description')}
        onChange={onDescriptionChange}
        onSave={onSave}
        onCancel={onCancel}
      />
    )
  }

  // Character: visual description + voice profile (stacked)
  return (
    <div className="relative flex flex-col" style={{ gap: '12px' }}>
      {/* Visual Description */}
      <SingleDescriptionInput
        value={description}
        isEditing={isEditing}
        title={t('visual_description')}
        showTitle={true}
        maxLength={maxLength}
        width={640}
        showButtons={false}
        useGradientBorder={isEditing}
        placeholder={t('enter_description')}
        onChange={onDescriptionChange}
        onSave={onSave}
        onCancel={onCancel}
      />

      {/* Voice Profile - hide in view mode if empty */}
      {(isEditing || (voiceProfile && voiceProfile.length > 0)) && (
        <SingleDescriptionInput
          value={voiceProfile}
          isEditing={isEditing}
          title={t('auditory_description')}
          showTitle={true}
          maxLength={maxVoiceLength}
          width={640}
          showButtons={false}
          useGradientBorder={isEditing}
          placeholder={t('enter_voice_profile')}
          onChange={onVoiceProfileChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}

      {/* Action buttons for character edit mode */}
      {isEditing && (
        <div
          className="flex items-center justify-end w-full max-w-full"
          style={{ gap: '12px', marginTop: '16px' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-text-primary transition-colors hover:bg-black/10"
            style={{
              backgroundColor: 'rgba(51, 51, 51, 0.06)',
              padding: '3px 14px',
              borderRadius: '6px',
              height: '24px',
              fontFamily: "'PingFang SC', sans-serif",
              fontWeight: 400,
              lineHeight: '18px',
            }}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            className="text-xs text-white transition-colors hover:opacity-90"
            style={{
              backgroundColor: '#FF8200',
              padding: '3px 14px',
              borderRadius: '6px',
              height: '24px',
              fontFamily: "'PingFang SC', sans-serif",
              fontWeight: 400,
              lineHeight: '18px',
            }}
          >
            {t('confirm')}
          </button>
        </div>
      )}
    </div>
  )
}
