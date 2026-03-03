// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { Clock } from 'lucide-react'

interface TimeWarningModalProps {
  isOpen: boolean
  onClose: () => void
  remainingMinutes: number
}

export function TimeWarningModal({ isOpen, onClose, remainingMinutes }: TimeWarningModalProps) {
  const { t } = useTranslation('evaluation')

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-[fadeIn_0.3s_ease-out]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 sm:p-10 animate-[scaleIn_0.25s_ease-out]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-center mb-4">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center">
            <Clock className="w-8 h-8 text-amber-600" />
          </div>
        </div>

        <h3 className="text-xl font-extrabold text-gray-900 mb-2 text-center">
          {t('grading:exam.time_warning.title', '考试即将结束')}
        </h3>

        <p className="text-base text-gray-600 mb-6 text-center">
          {t(
            'grading:exam.time_warning.description',
            `距离考试结束还有 {{minutes}} 分钟，请尽快完成作答并准备提交。`,
            { minutes: remainingMinutes }
          )}
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
          <p className="text-sm text-amber-800">
            {t(
              'grading:exam.time_warning.hint',
              '建议：检查是否已完成所有必传项（作答说明、考核报告、交互记录），确认无误后及时提交。'
            )}
          </p>
        </div>

        <button
          onClick={onClose}
          className="w-full px-5 py-3 rounded-2xl bg-[#DF2029] hover:bg-[#c81d25] text-white text-base font-bold transition shadow-lg shadow-red-200/50"
        >
          {t('common:actions.got_it', '我知道了')}
        </button>
      </div>
    </div>
  )
}
