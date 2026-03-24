// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'
import type { ExamAttachment, AnswerSlot } from '@wecode/types/evaluation-exam'

export interface Topic {
  id: number
  title: string
  shortDesc: string
  icon: string
  context: string
  tasks: Array<{ name: string; desc: string }>
  requirement: string
  deliverable: string[]
  bonusDeliverable: string[]
  scenarios?: string[]
  contextSuffix?: string
  tasksLabel?: string
  /** Optional material package attachments for exam takers to download */
  attachments?: ExamAttachment[]
  /** Answer slot configuration for dynamic answer collection */
  answerSlots?: AnswerSlot[]
}

interface AIAssessmentTopicCardProps {
  topic: Topic
  selected: boolean
  onClick: () => void
  disabled?: boolean
  displayIndex?: number
}

export function AIAssessmentTopicCard({
  topic,
  selected,
  onClick,
  disabled,
  displayIndex,
}: AIAssessmentTopicCardProps) {
  const colorMap: Record<string, { bg: string; text: string; tag: string }> = {
    robot: { bg: 'bg-violet-50', text: 'text-violet-600', tag: 'bg-violet-100 text-violet-700' },
    globe: {
      bg: 'bg-emerald-50',
      text: 'text-emerald-600',
      tag: 'bg-emerald-100 text-emerald-700',
    },
    sparkle: { bg: 'bg-amber-50', text: 'text-amber-600', tag: 'bg-amber-100 text-amber-700' },
  }
  const c = colorMap[topic.icon] || colorMap.robot

  return (
    <button
      className={`relative rounded-2xl border-2 p-7 cursor-pointer bg-white transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] text-left w-full ${
        selected
          ? 'border-[#DF2029] shadow-[0_0_0_3px_rgba(223,32,41,0.12),0_8px_24px_-6px_rgba(223,32,41,0.15)]'
          : disabled
            ? 'border-gray-100 opacity-40 cursor-not-allowed'
            : 'border-gray-100 hover:border-gray-200 hover:-translate-y-[3px] hover:shadow-[0_12px_28px_-8px_rgba(0,0,0,0.12)]'
      }`}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {selected && (
        <div className="absolute top-5 right-5 w-7 h-7 rounded-full bg-[#DF2029] flex items-center justify-center animate-[checkPop_0.4s_ease-out]">
          <Icon name="check" size={16} className="text-white" />
        </div>
      )}
      <div className={`w-12 h-12 rounded-xl ${c.bg} flex items-center justify-center mb-4`}>
        <Icon name={topic.icon} size={24} className={c.text} />
      </div>
      <span className={`inline-block text-sm font-semibold px-2.5 py-1 rounded-full ${c.tag} mb-3`}>
        题目{displayIndex ?? topic.id}
      </span>
      <h3 className="text-lg font-bold text-gray-900 leading-snug mb-2">{topic.title}</h3>
      <p className="text-[1rem] text-gray-500 leading-relaxed">{topic.shortDesc}</p>
    </button>
  )
}
