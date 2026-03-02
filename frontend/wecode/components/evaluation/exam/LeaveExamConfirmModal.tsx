// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'

interface LeaveExamConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
}

export function LeaveExamConfirmModal({ isOpen, onClose, onConfirm }: LeaveExamConfirmModalProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-[fadeIn_0.3s_ease-out]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full p-10 text-center animate-[scaleIn_0.25s_ease-out]">
        <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-5">
          <Icon name="logOut" size={40} className="text-emerald-500" />
        </div>
        <h3 className="text-2xl font-extrabold text-gray-900 mb-2">确认离开考试</h3>
        <p className="text-[1rem] text-gray-500 mb-4">
          离开考试后将结束本次考核，您将不能再查看或修改作答内容。
        </p>
        <p className="text-sm text-gray-400 mb-8">请确认您已完成所有检查并准备提交。</p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-6 py-3 rounded-2xl bg-gray-100 text-[1rem] font-medium text-gray-700 hover:bg-gray-200 transition"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-6 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white text-[1rem] font-bold transition"
          >
            确认离开
          </button>
        </div>
      </div>
    </div>
  )
}
