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
  supplementaryNotesFilesCount: number
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
  supplementaryNotesFilesCount,
}: ConfirmModalProps) {
  const { t } = useTranslation('evaluation')

  if (!isOpen) return null

  const items = [
    ['考生姓名', participantName || '未填写'],
    ['选择题目', selectedTopicTitle || '未选择'],
    [
      '作答说明',
      supplementaryNotesLength > 0
        ? `${supplementaryNotesLength} 字`
        : supplementaryNotesFilesCount > 0
          ? `已上传 ${supplementaryNotesFilesCount} 个文件`
          : '未填写',
    ],
    ['交互记录', `${interactionFilesCount} 个文件`],
    ['产出结果', `${mainFilesCount} 个文件`],
    ['附加题一', hasBonusAgent ? '已提供' : '未提供'],
    ['附加题二', hasBonusMultimodal ? '已提供' : '未提供'],
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
          {t('grading:exam.confirm.title', '确认提交')}
        </h3>
        <p className="text-base text-gray-500 mb-6">
          {t('grading:exam.confirm.description', '请确认以下提交内容无误')}
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
            {t('common:actions.cancel', '返回修改')}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-5 py-3 rounded-2xl bg-[#DF2029] hover:bg-[#c81d25] text-white text-base font-bold transition shadow-lg shadow-red-200/50"
          >
            {t('common:actions.confirm', '确认提交')}
          </button>
        </div>
      </div>
    </div>
  )
}
