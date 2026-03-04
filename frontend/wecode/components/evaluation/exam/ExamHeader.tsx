// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExamTimerDisplay } from '../common/ExamTimerDisplay'
import { Icon } from './ExamIcons'

interface ProgressStep {
  label: string
  done: boolean
}

interface ExamHeaderProps {
  title: string
  year: string
  progressSteps: ProgressStep[]
  timeLeft: number
  timerColor: string
  showTimer: boolean
}

export function ExamHeader({
  title,
  year,
  progressSteps,
  timeLeft,
  timerColor,
  showTimer,
}: ExamHeaderProps) {
  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <h1 className="text-[1rem] font-bold text-gray-900 truncate">{title}</h1>
            <p className="text-xs text-gray-400">{year}年度</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2">
            {progressSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${step.done ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-400'}`}
                >
                  {step.done && <Icon name="check" size={12} className="text-green-500" />}
                  <span>{step.label}</span>
                </div>
                {i < progressSteps.length - 1 && (
                  <div className={`w-4 h-px ${step.done ? 'bg-green-200' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
          {showTimer && (
            <ExamTimerDisplay
              initialRemainingSeconds={timeLeft}
              phase="exam"
              size="lg"
              colorClass={timerColor}
            />
          )}
        </div>
      </div>
    </header>
  )
}
