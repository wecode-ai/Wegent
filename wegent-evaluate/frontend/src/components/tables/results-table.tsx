'use client'

import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { EvaluationResultItem } from '@/types'
import { CheckCircle, XCircle, Clock, AlertTriangle, Trophy, ShieldAlert } from 'lucide-react'

interface ResultsTableProps {
  items: EvaluationResultItem[]
}

const statusIcons = {
  completed: <CheckCircle className="h-4 w-4 text-green-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  pending: <Clock className="h-4 w-4 text-yellow-500" />,
  processing: <Clock className="h-4 w-4 text-blue-500" />,
  skipped: <AlertTriangle className="h-4 w-4 text-gray-500" />,
}

export function ResultsTable({ items }: ResultsTableProps) {
  const { t } = useTranslation()

  const formatScore = (score?: number) => {
    if (score === undefined || score === null) return '-'
    return `${(score * 100).toFixed(1)}%`
  }

  const formatTotalScore = (score?: number) => {
    if (score === undefined || score === null) return '-'
    return score.toFixed(1)
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-medium">ID</th>
            <th className="px-4 py-3 text-left font-medium">
              {t('results.userPrompt', 'User Prompt')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('results.status', 'Status')}
            </th>
            {/* New Total Score column */}
            <th className="px-4 py-3 text-left font-medium">
              <span className="flex items-center gap-1">
                <Trophy className="h-4 w-4 text-primary" />
                {t('metrics.totalScore', 'Total')}
              </span>
            </th>
            {/* Pass/Fail Status */}
            <th className="px-4 py-3 text-left font-medium">
              {t('metrics.passStatus', 'Pass/Fail')}
            </th>
            {/* Core metrics */}
            <th className="px-4 py-3 text-left font-medium">
              <span className="text-green-600">
                {t('results.faithfulness', 'Faithfulness')}
              </span>
            </th>
            <th className="px-4 py-3 text-left font-medium">
              <span className="text-blue-600">
                {t('resultDetail.groundedness', 'Groundedness')}
              </span>
            </th>
            {/* Legacy metrics */}
            <th className="px-4 py-3 text-left font-medium">
              {t('results.answerRelevancy', 'Answer Rel.')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('results.contextPrecision', 'Context Prec.')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('results.overall', 'Overall')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('results.hasIssue', 'Issue')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('dashboard.cvAlerts', 'CV Alert')}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {t('common.actions', 'Actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.conversation_record_id}
              className={`border-t hover:bg-secondary/50 ${
                item.is_failed ? 'bg-red-50/50' : ''
              }`}
            >
              <td className="px-4 py-3">{item.conversation_record_id}</td>
              <td className="max-w-[200px] truncate px-4 py-3">
                {item.user_prompt}
              </td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-1">
                  {statusIcons[item.evaluation_status as keyof typeof statusIcons]}
                  {item.evaluation_status}
                </span>
              </td>
              {/* Total Score */}
              <td className="px-4 py-3">
                <span
                  className={`font-semibold ${
                    item.is_failed
                      ? 'text-gray-400 line-through'
                      : item.total_score && item.total_score >= 70
                        ? 'text-green-600'
                        : item.total_score && item.total_score >= 50
                          ? 'text-yellow-600'
                          : 'text-red-600'
                  }`}
                >
                  {formatTotalScore(item.total_score)}
                </span>
              </td>
              {/* Pass/Fail Status */}
              <td className="px-4 py-3">
                {item.is_failed ? (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700"
                    title={item.failure_reason || undefined}
                  >
                    <XCircle className="h-3 w-3" />
                    {t('metrics.failed', 'FAILED')}
                  </span>
                ) : item.total_score != null ? (
                  <span className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                    <CheckCircle className="h-3 w-3" />
                    {t('metrics.passed', 'PASSED')}
                  </span>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
              {/* Faithfulness with threshold warning */}
              <td className="px-4 py-3">
                <span
                  className={
                    item.faithfulness_score != null && item.faithfulness_score < 0.6
                      ? 'text-red-600 font-medium'
                      : ''
                  }
                >
                  {formatScore(item.faithfulness_score)}
                  {item.faithfulness_score != null && item.faithfulness_score < 0.6 && (
                    <span className="ml-1 text-red-500">⚠️</span>
                  )}
                </span>
              </td>
              {/* Groundedness (事实性) with threshold warning */}
              <td className="px-4 py-3">
                <span
                  className={
                    item.trulens_groundedness != null && item.trulens_groundedness < 0.6
                      ? 'text-red-600 font-medium'
                      : ''
                  }
                >
                  {formatScore(item.trulens_groundedness)}
                  {item.trulens_groundedness != null && item.trulens_groundedness < 0.6 && (
                    <span className="ml-1 text-red-500">⚠️</span>
                  )}
                </span>
              </td>
              <td className="px-4 py-3">
                {formatScore(item.answer_relevancy_score)}
              </td>
              <td className="px-4 py-3">
                {formatScore(item.context_precision_score)}
              </td>
              <td className="px-4 py-3 font-medium">
                {formatScore(item.overall_score)}
              </td>
              <td className="px-4 py-3">
                {item.has_issue ? (
                  <span className="rounded bg-red-100 px-2 py-1 text-xs text-red-700">
                    {t('common.yes', 'Yes')}
                  </span>
                ) : (
                  <span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700">
                    {t('common.no', 'No')}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                {item.has_cv_alert ? (
                  <span className="inline-flex items-center rounded bg-purple-100 px-2 py-1 text-xs text-purple-700">
                    <ShieldAlert className="h-3 w-3 mr-1" />
                    {t('common.yes', 'Yes')}
                  </span>
                ) : (
                  <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700">
                    {t('common.no', 'No')}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                {item.id && (
                  <Link
                    href={`/results/${item.id}`}
                    className="text-primary hover:underline"
                  >
                    {t('common.view', 'View')}
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
