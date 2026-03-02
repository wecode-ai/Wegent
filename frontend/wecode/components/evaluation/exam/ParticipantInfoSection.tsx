// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'

interface ParticipantInfoSectionProps {
  participantName: string
}

export function ParticipantInfoSection({ participantName }: ParticipantInfoSectionProps) {
  return (
    <section className="animate-[fadeIn_0.3s_ease-out] bg-white rounded-3xl shadow-sm border border-gray-100 p-8">
      <div className="flex items-center gap-2.5 mb-5">
        <Icon name="user" size={20} className="text-gray-400" />
        <h2 className="text-xl font-bold text-gray-900">考生信息</h2>
      </div>
      <div className="max-w-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Icon name="user" size={20} className="text-primary" />
          </div>
          <div>
            <p className="text-sm text-gray-500">用户名</p>
            <p className="text-[1rem] font-medium text-gray-900">{participantName || '-'}</p>
          </div>
        </div>
      </div>
    </section>
  )
}
