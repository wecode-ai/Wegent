// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import type { AnswerSlot, SlotAnswer } from '@wecode/types/evaluation-exam'
import { DynamicSlotInput } from './DynamicSlotInput'
import { useTranslation } from '@/hooks/useTranslation'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface DynamicAnswerUploadZoneProps {
  topicId: number
  questionId: number
  answerSlots: AnswerSlot[]
  answers: Record<string, SlotAnswer>
  onChange: (slotKey: string, value: SlotAnswer) => void
  onAnswersUpdate?: (answers: Record<string, SlotAnswer>) => void
  disabled?: boolean
  /** Total file limit across all slots */
  totalFileLimit?: number
  /** Callback when total limit is exceeded */
  onLimitExceeded?: () => void
  /** Callback when text/link field changes (for debounced auto-save) */
  onTextChange?: (slotKey: string) => void
  /** Save status for text inputs (keyed by slot key) */
  textSaveStatus?: Record<string, SaveStatus>
  /** Last saved timestamp for text inputs (keyed by slot key) */
  textLastSavedAt?: Record<string, Date | null>
}

/**
 * Dynamic answer upload zone component for exam submissions.
 * Renders answer slots based on question configuration (answerSlots).
 * - Text-mode slots are rendered in their own section (like SupplementaryNotesSection)
 * - Non-text slots (attachment, link+attachment) are rendered together
 * - Bonus slots are filtered out (should be rendered separately in BonusItemsSection)
 */
export function DynamicAnswerUploadZone({
  topicId,
  questionId,
  answerSlots,
  answers,
  onChange,
  onAnswersUpdate,
  disabled = false,
  totalFileLimit = 20,
  onLimitExceeded,
  onTextChange,
  textSaveStatus = {},
  textLastSavedAt = {},
}: DynamicAnswerUploadZoneProps) {
  const { t } = useTranslation('evaluation')

  // Filter out bonus slots and separate text-mode slots from attachment slots
  // Note: bonus slots are rendered in BonusItemsSection for description only,
  // but their input UI is rendered here in the upload zone
  const { textSlots, attachmentSlots } = useMemo(() => {
    // Include all slots (including bonus) for input
    return {
      textSlots: answerSlots.filter(slot => slot.inputMode === 'text'),
      attachmentSlots: answerSlots.filter(slot => slot.inputMode !== 'text'),
    }
  }, [answerSlots])

  // Calculate total file count across all slots
  const totalFileCount = useMemo(() => {
    return Object.values(answers).reduce((sum, answer) => {
      return sum + (answer.files?.length || 0)
    }, 0)
  }, [answers])

  const handleSlotChange = (slotKey: string, value: SlotAnswer) => {
    // Check total file limit before accepting new files
    const currentSlotFiles = answers[slotKey]?.files?.length || 0
    const newSlotFiles = value.files?.length || 0
    const filesDelta = newSlotFiles - currentSlotFiles

    if (filesDelta > 0 && totalFileCount + filesDelta > totalFileLimit) {
      onLimitExceeded?.()
      return
    }

    onChange(slotKey, value)

    // Notify parent to update backend
    const updatedAnswers = { ...answers, [slotKey]: value }
    onAnswersUpdate?.(updatedAnswers)
  }

  const hasTextSlots = textSlots.length > 0
  const hasAttachmentSlots = attachmentSlots.length > 0

  if (!hasTextSlots && !hasAttachmentSlots) {
    return null
  }

  return (
    <>
      {/* Text-mode slots - each in its own section (like SupplementaryNotesSection) */}
      {textSlots.map(slot => (
        <section key={slot._id || slot.key} className="animate-[slideDown_0.35s_ease-out]">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              {slot.label}
              {slot.required && (
                <span className="text-[#DF2029] text-sm font-normal">
                  （{t('slots.required')}）
                </span>
              )}
            </h2>
          </div>
          <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
            <DynamicSlotInput
              slot={slot}
              value={answers[slot.key] || { text: '' }}
              onChange={value => handleSlotChange(slot.key, value)}
              disabled={disabled}
              topicId={topicId}
              questionId={questionId}
              onTextChange={() => onTextChange?.(slot.key)}
              saveStatus={textSaveStatus[slot.key] || 'idle'}
              lastSavedAt={textLastSavedAt[slot.key] || null}
            />
          </div>
        </section>
      ))}

      {/* Attachment slots - grouped together */}
      {hasAttachmentSlots && (
        <section className="animate-[slideDown_0.35s_ease-out]">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
            <h2 className="text-xl font-bold text-gray-900">{t('exam.upload.title')}</h2>
          </div>
          <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9 space-y-6">
            {attachmentSlots.map((slot, index) => (
              <div key={slot._id || slot.key}>
                {index > 0 && <hr className="border-gray-100 mb-6" />}
                <DynamicSlotInput
                  slot={slot}
                  value={answers[slot.key] || { files: [] }}
                  onChange={value => handleSlotChange(slot.key, value)}
                  disabled={disabled}
                  topicId={topicId}
                  questionId={questionId}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
