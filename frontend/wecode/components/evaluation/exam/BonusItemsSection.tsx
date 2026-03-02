// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'

interface BonusItem {
  id: number
  title: string
  description: string
  platforms: string
  deliverables: string[]
}

interface BonusItemsSectionProps {
  bonusItems: BonusItem[]
}

export function BonusItemsSection({ bonusItems }: BonusItemsSectionProps) {
  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-purple-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900">附加题</h2>
        <span className="text-[1rem] text-gray-400 ml-1">（可选加分项）</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {bonusItems.map(item => (
          <div key={item.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-7">
            <div className="flex items-start gap-3 mb-4">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${item.id === 1 ? 'bg-indigo-50' : 'bg-rose-50'}`}
              >
                <Icon
                  name={item.id === 1 ? 'workflow' : 'layers'}
                  size={20}
                  className={item.id === 1 ? 'text-indigo-500' : 'text-rose-500'}
                />
              </div>
              <div>
                <span
                  className={`inline-block text-xs font-bold px-2.5 py-1 rounded-full mb-2 ${item.id === 1 ? 'bg-indigo-100 text-indigo-700' : 'bg-rose-100 text-rose-700'}`}
                >
                  附加题{item.id}
                </span>
                <h3 className="text-[1rem] font-bold text-gray-900">{item.title}</h3>
              </div>
            </div>
            <p className="text-[1rem] text-gray-600 leading-[1.8] mb-3">{item.description}</p>
            <p className="text-sm text-gray-500 mb-4">{item.platforms}</p>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-sm font-bold text-gray-500 mb-2">交付参考：</p>
              {item.deliverables.map((d, i) => (
                <p
                  key={i}
                  className="text-sm text-gray-600 leading-relaxed mb-1.5 last:mb-0 flex items-start gap-2"
                >
                  <span className="text-gray-300 mt-0.5">•</span>
                  <span>{d}</span>
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
