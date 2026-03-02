// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'

interface ExamRule {
  icon: string
  label: string
  text: string
}

interface ExamMethod {
  scoring: string
  dimensions: string[]
  bonus: string
}

interface ExamInfoSectionProps {
  title: string
  year: string
  rules: ExamRule[]
  examMethod: ExamMethod
  timeNote: string
  examPhase: string
  loading: boolean
  isTransitioning: boolean
  onStartAnswering: () => void
}

export function ExamInfoSection({
  title,
  year,
  rules,
  examMethod,
  timeNote,
  examPhase,
  loading,
  isTransitioning,
  onStartAnswering,
}: ExamInfoSectionProps) {
  return (
    <section className="bg-white rounded-3xl shadow-sm border border-gray-100 p-8 sm:p-10">
      <div className="flex items-center gap-3 mb-2">
        <span className="inline-block text-sm font-bold px-3 py-1 rounded-full bg-[#DF2029]/10 text-[#DF2029]">
          {year}年度
        </span>
      </div>
      <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 mb-4">{title}</h2>
      <p className="text-gray-600 mb-8">
        本考核旨在评估高层管理人员的 AI 应用能力，包括工具使用、问题解决和创新思维等方面。
      </p>

      {/* Loading state */}
      {loading && (
        <div className="flex justify-center py-10">
          <div className="text-gray-500">加载中...</div>
        </div>
      )}

      {/* Ready phase - waiting for user to enter */}
      {!loading && examPhase === 'ready' && (
        <div className="flex flex-col items-center gap-4 py-10">
          <p className="text-gray-600 mb-4">考试即将开始，请点击下方按钮进入考试</p>
          <button
            onClick={onStartAnswering}
            disabled={isTransitioning}
            className={`px-10 py-3.5 bg-[#DF2029] hover:bg-[#c81d25] text-white text-lg font-bold rounded-2xl shadow-lg shadow-red-200/50 transition-all hover:shadow-red-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isTransitioning ? '加载中...' : '进入考试'}
          </button>
        </div>
      )}

      {/* Intro/Exam/Review/Completed phases - show full exam info */}
      {!loading &&
        (examPhase === 'intro' ||
          examPhase === 'exam' ||
          examPhase === 'review' ||
          examPhase === 'completed') && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
              {rules.map((rule, i) => (
                <div
                  key={i}
                  className="flex items-start gap-4 bg-gray-50 rounded-2xl p-5 border border-gray-100"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#DF2029]/[0.08] flex items-center justify-center flex-shrink-0">
                    <Icon name={rule.icon} size={20} className="text-[#DF2029]" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-500 mb-0.5">{rule.label}</p>
                    <p className="text-[1rem] text-gray-700 leading-relaxed">{rule.text}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Exam method */}
            <div className="bg-red-50/50 rounded-2xl p-6 border border-red-100/60 mb-6">
              <h3 className="text-[1rem] font-bold text-gray-800 mb-3">考核方式</h3>
              <p className="text-[1rem] text-gray-600 mb-3">{examMethod.scoring}</p>
              <p className="text-[1rem] text-gray-600 mb-3">
                评估维度：{examMethod.dimensions.join('、')}
              </p>
              <p className="text-[1rem] font-bold text-gray-600 mb-3">{examMethod.bonus}</p>
            </div>

            {/* Time note */}
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-8">
              <Icon
                name="alertTriangle"
                size={20}
                className="text-amber-500 flex-shrink-0 mt-0.5"
              />
              <p className="text-[1rem] text-amber-800 leading-relaxed">{timeNote}</p>
            </div>

            {/* Phase Control Buttons for intro phase */}
            {examPhase === 'intro' && (
              <div className="flex flex-col items-center gap-4">
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-2">当前阶段：考前介绍答疑</p>
                  <p className="text-[1rem] text-gray-700">
                    请仔细阅读考试说明，准备好后点击开始答题
                  </p>
                </div>
                <button
                  onClick={onStartAnswering}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-[#DF2029] hover:bg-[#c81d25] text-white text-lg font-bold rounded-2xl shadow-lg shadow-red-200/50 transition-all hover:shadow-red-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '开始答题'}
                </button>
              </div>
            )}
          </>
        )}
    </section>
  )
}
