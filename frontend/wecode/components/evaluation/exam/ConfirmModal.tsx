// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  participantName: string
  selectedTopicTitle: string
  mainFilesCount: number
  interactionFilesCount: number
  hasBonusAgent: boolean
  hasBonusMultimodal: boolean
  supplementaryNotesLength: number
  /** @deprecated This field is no longer used, kept for backward compatibility */
  supplementaryNotesFilesCount?: number
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  participantName,
  selectedTopicTitle,
  mainFilesCount,
  interactionFilesCount,
  hasBonusAgent,
  hasBonusMultimodal,
  supplementaryNotesLength,
  supplementaryNotesFilesCount = 0,
}: ConfirmModalProps) {
  const { t } = useTranslation('evaluation')

  if (!isOpen) return null

  const items = [
    [t('exam.confirm.participant_name'), participantName || t('exam.confirm.not_filled')],
    [t('exam.confirm.selected_topic'), selectedTopicTitle || t('exam.confirm.not_selected')],
    [
      t('exam.confirm.supplementary_notes'),
      supplementaryNotesLength > 0
        ? t('exam.confirm.character_count', { count: supplementaryNotesLength })
        : supplementaryNotesFilesCount > 0
          ? t('exam.confirm.file_count', { count: supplementaryNotesFilesCount })
          : t('exam.confirm.not_filled'),
    ],
    [t('exam.confirm.interaction_record'), t('exam.confirm.file_count', { count: interactionFilesCount })],
    [t('exam.confirm.main_report'), t('exam.confirm.file_count', { count: mainFilesCount })],
    [t('exam.confirm.bonus_1'), hasBonusAgent ? t('exam.confirm.provided') : t('exam.confirm.not_provided')],
    [t('exam.confirm.bonus_2'), hasBonusMultimodal ? t('exam.confirm.provided') : t('exam.confirm.not_provided')],
  ]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-[fadeIn_0.3s_ease-out]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-3xl shadow-2xl max-w-lg w-full p-8 sm:p-10 animate-[scaleIn_0.25s_ease-out]"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-xl font-extrabold text-gray-900 mb-1">
          {t('exam.confirm.title')}
        </h3>
        <p className="text-base text-gray-500 mb-6">
          {t('exam.confirm.description')}
        </p>

        <div className="space-y-3 mb-8">
          {items.map(([key, value], i) => (
            <div
              key={i}
              className="flex justify-between items-start py-2.5 border-b border-gray-100 last:border-0"
            >
              <span className="text-base text-gray-500">{key}</span>
              <span className="text-base font-medium text-gray-900 text-right max-w-[60%]">
                {value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-5 py-3 rounded-2xl border border-gray-200 text-base font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            {t('exam.confirm.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-5 py-3 rounded-2xl bg-[#DF2029] hover:bg-[#c81d25] text-white text-base font-bold transition shadow-lg shadow-red-200/50"
          >
            {t('exam.confirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
