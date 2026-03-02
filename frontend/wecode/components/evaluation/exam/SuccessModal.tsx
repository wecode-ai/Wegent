// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'

interface SuccessModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Check circle icon component
 */
function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

/**
 * Success modal shown after exam submission is completed.
 * Displays a success icon and confirmation message.
 */
export function SuccessModal({ isOpen, onClose }: SuccessModalProps) {
  const { t } = useTranslation('evaluation')

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-[fadeIn_0.3s_ease-out]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full p-10 text-center animate-[scaleIn_0.25s_ease-out]">
        <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5 animate-[checkPop_0.4s_ease-out]">
          <CheckCircleIcon className="text-green-500" />
        </div>
        <h3 className="text-2xl font-extrabold text-gray-900 mb-2">
          {t('grading:exam.success.title', '提交成功')}
        </h3>
        <p className="text-base text-gray-500 mb-8">
          {t('grading:exam.success.description', '考核材料已提交成功。')}
        </p>
        <button
          onClick={onClose}
          className="px-8 py-3 rounded-2xl bg-gray-100 text-base font-medium text-gray-700 hover:bg-gray-200 transition"
        >
          {t('common:actions.close', '关闭')}
        </button>
      </div>
    </div>
  )
}
