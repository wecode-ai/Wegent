// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import type { AnswerSlot } from '@wecode/types/evaluation-exam'
import { Icon } from './ExamIcons'
import { SlotMarkdownContent } from './SlotMarkdownContent'
import { useTranslation } from '@/hooks/useTranslation'

// Legacy interface for backward compatibility
interface LegacyBonusItem {
  id: number
  title: string
  description: string
  platforms: string
  deliverables: string[]
}

interface BonusItemsSectionProps {
  /** Answer slots - will filter to bonus slots (isBonus=true) */
  slots?: AnswerSlot[]
  /** Legacy: Direct bonus items array (deprecated, use slots instead) */
  bonusItems?: LegacyBonusItem[]
}

// Color palette for bonus items (cycles through)
const BONUS_COLORS = [
  { bg: 'bg-indigo-50', text: 'text-indigo-500', badge: 'bg-indigo-100 text-indigo-700' },
  { bg: 'bg-rose-50', text: 'text-rose-500', badge: 'bg-rose-100 text-rose-700' },
  { bg: 'bg-amber-50', text: 'text-amber-500', badge: 'bg-amber-100 text-amber-700' },
  { bg: 'bg-emerald-50', text: 'text-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
]

// Icon mapping for bonus items
const BONUS_ICONS: Array<'workflow' | 'layers' | 'puzzle' | 'rocket'> = [
  'workflow',
  'layers',
  'puzzle',
  'rocket',
]

export function BonusItemsSection({ slots, bonusItems }: BonusItemsSectionProps) {
  const { t } = useTranslation('evaluation')

  // Filter bonus slots from answer slots
  const bonusSlots = useMemo(() => {
    if (slots) {
      return slots.filter(slot => slot.isBonus)
    }
    return []
  }, [slots])

  // Use bonus slots if available, otherwise fall back to legacy bonusItems
  const hasNewBonusSlots = bonusSlots.length > 0
  const hasLegacyBonusItems = bonusItems && bonusItems.length > 0

  // If no bonus content, don't render
  if (!hasNewBonusSlots && !hasLegacyBonusItems) {
    return null
  }

  // Grid layout: 1 item = full width, 2 items = 2 cols, 3+ items = 3 cols
  const itemCount = hasNewBonusSlots ? bonusSlots.length : bonusItems?.length || 0
  const gridClass =
    itemCount === 1 ? 'md:grid-cols-1' : itemCount === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'

  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-purple-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900">{t('slots.bonus')}</h2>
        <span className="text-[1rem] text-gray-400 ml-1">（{t('slots.optional')}）</span>
      </div>

      {/* Render new-style bonus slots */}
      {hasNewBonusSlots && (
        <div className={`grid grid-cols-1 ${gridClass} gap-5`}>
          {bonusSlots.map((slot, index) => {
            const colorScheme = BONUS_COLORS[index % BONUS_COLORS.length]
            const iconName = BONUS_ICONS[index % BONUS_ICONS.length]

            return (
              <div
                key={slot._id || slot.key}
                className="bg-white rounded-2xl shadow-sm border border-gray-100 p-7"
              >
                <div className="flex items-start gap-3 mb-4">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${colorScheme.bg}`}
                  >
                    <Icon
                      name={(slot.icon as keyof typeof Icon) || iconName}
                      size={20}
                      className={colorScheme.text}
                    />
                  </div>
                  <div>
                    <span
                      className={`inline-block text-xs font-bold px-2.5 py-1 rounded-full mb-2 ${colorScheme.badge}`}
                    >
                      {t('slots.bonus')}
                      {index + 1}
                    </span>
                    <h3 className="text-[1rem] font-bold text-gray-900">
                      {slot.title || slot.label}
                    </h3>
                  </div>
                </div>
                {/* Render content with Markdown support */}
                {slot.contentMarkdown && <SlotMarkdownContent content={slot.contentMarkdown} />}
              </div>
            )
          })}
        </div>
      )}

      {/* Render legacy bonus items (for backward compatibility) */}
      {!hasNewBonusSlots && hasLegacyBonusItems && (
        <div className={`grid grid-cols-1 ${gridClass} gap-5`}>
          {bonusItems!.map(item => (
            <div
              key={item.id}
              className="bg-white rounded-2xl shadow-sm border border-gray-100 p-7"
            >
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
                    {t('slots.bonus')}
                    {item.id}
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
      )}
    </section>
  )
}
