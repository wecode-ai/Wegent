// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'
import type { Topic } from './AIAssessmentTopicCard'

interface AIAssessmentTopicDetailProps {
  topic: Topic
}

export function AIAssessmentTopicDetail({ topic }: AIAssessmentTopicDetailProps) {
  if (!topic) return null

  return (
    <div className="animate-[slideDown_0.35s_ease-out] bg-white rounded-2xl shadow-md p-7 md:p-9">
      <div className="flex items-start gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Icon name={topic.icon} size={20} className="text-[#DF2029]" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 leading-snug">{topic.title}</h3>
      </div>

      <div className="mb-6 text-[1rem] text-gray-600 leading-[1.8] whitespace-pre-line">
        {topic.context}
      </div>

      {topic.scenarios && (
        <div className="mb-6 bg-gray-50 rounded-2xl p-5 space-y-2.5">
          {topic.scenarios.map((s, i) => (
            <p key={i} className="text-[1rem] text-gray-700 leading-relaxed">
              {s}
            </p>
          ))}
        </div>
      )}

      {topic.contextSuffix && (
        <div className="mb-6 text-[1rem] text-gray-600 leading-[1.8]">{topic.contextSuffix}</div>
      )}

      {topic.tasksLabel && (
        <p className="text-[1rem] font-semibold text-gray-700 mb-4">{topic.tasksLabel}</p>
      )}

      <div className="bg-gray-50 rounded-2xl p-6 mb-6">
        <div className="space-y-4">
          {topic.tasks.map((task, i) => (
            <div key={i} className="flex gap-4">
              <div className="w-7 h-7 rounded-full bg-[#DF2029]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-sm font-bold text-[#DF2029]">{i + 1}</span>
              </div>
              <div>
                <p className="text-[1rem] font-bold text-gray-800 mb-1">{task.name}</p>
                <p className="text-[1rem] text-gray-600 leading-[1.8]">{task.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-gray-50 rounded-2xl p-6 space-y-4">
        <div className="flex gap-3">
          <div className="w-1.5 bg-gray-200 rounded-full flex-shrink-0" />
          <div>
            <p className="text-[1rem] font-semibold text-gray-700 mb-2">要求</p>
            <p className="text-[1rem] text-gray-600 leading-relaxed mb-1">{topic.requirement}</p>
            <p className="text-[1rem] font-semibold text-gray-700 mb-2 mt-4">交付内容</p>
            <div className="space-y-2">
              {topic.deliverable.map((item, index) => (
                <p key={index} className="text-[1rem] text-gray-600 leading-relaxed mb-1">
                  {item}
                </p>
              ))}
            </div>
            <p className="text-[1rem] font-semibold text-gray-700 mb-2 mt-4">附加题交付</p>
            <div className="space-y-2">
              {topic.bonusDeliverable.map((item, index) => (
                <p key={index} className="text-[1rem] text-gray-600 leading-relaxed mb-1">
                  {item}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
