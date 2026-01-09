'use client'

import { useState, useEffect, use } from 'react'
import { useTranslation } from 'react-i18next'
import { ScoreCard } from '@/components/charts/score-card'
import {
  TotalScoreCard,
  TieredMetricsSection,
} from '@/components/metrics'
import {
  ArrowLeft,
  RefreshCcw,
  Loader2,
  AlertTriangle,
  CheckCircle,
  Info,
  Brain,
  Cpu,
  GitCompare,
  ShieldCheck,
  ShieldAlert,
  Target,
  Zap,
  Search,
} from 'lucide-react'
import Link from 'next/link'
import {
  getEvaluationResultDetail,
  triggerEvaluation,
  getEvaluationStatus,
} from '@/apis/evaluation'
import { EvaluationResultDetail as ResultDetail, DiagnosticAnalysis } from '@/types'

function getRatingColor(rating: string): string {
  switch (rating) {
    case 'excellent':
      return 'bg-green-100 text-green-700'
    case 'good':
      return 'bg-blue-100 text-blue-700'
    case 'fair':
      return 'bg-yellow-100 text-yellow-700'
    case 'poor':
      return 'bg-red-100 text-red-700'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

function getRatingLabel(rating: string, t: (key: string) => string): string {
  switch (rating) {
    case 'excellent':
      return t('resultDetail.excellent')
    case 'good':
      return t('resultDetail.good')
    case 'fair':
      return t('resultDetail.fair')
    case 'poor':
      return t('resultDetail.poor')
    default:
      return rating.toUpperCase()
  }
}

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'high':
      return 'bg-red-100 text-red-700'
    case 'medium':
      return 'bg-yellow-100 text-yellow-700'
    case 'low':
      return 'bg-blue-100 text-blue-700'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

function getSeverityLabel(severity: string, t: (key: string) => string): string {
  switch (severity) {
    case 'high':
      return t('resultDetail.high')
    case 'medium':
      return t('resultDetail.medium')
    case 'low':
      return t('resultDetail.low')
    default:
      return severity.toUpperCase()
  }
}

function DiagnosticCard({
  analysis,
  title,
  icon,
  t,
}: {
  analysis: DiagnosticAnalysis
  title: string
  icon: React.ReactNode
  t: (key: string) => string
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {icon}
          <div className="text-left">
            <h3 className="font-medium">{title}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-xs px-2 py-0.5 rounded ${getRatingColor(analysis.overall_rating)}`}
              >
                {getRatingLabel(analysis.overall_rating, t)}
              </span>
              {analysis.has_issues && (
                <span className="text-xs text-red-600 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {analysis.issues.length} {t('resultDetail.issueCount')}
                </span>
              )}
            </div>
          </div>
        </div>
        <span className="text-muted-foreground text-xl">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="border-t p-4 space-y-4">
          {/* Summary */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-1">
              {t('resultDetail.summary')}
            </h4>
            <p className="text-sm">{analysis.summary}</p>
          </div>

          {/* Issues */}
          {analysis.issues.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                {t('resultDetail.issues')}
              </h4>
              <div className="space-y-2">
                {analysis.issues.map((issue, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 rounded bg-secondary/50 p-3"
                  >
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${getSeverityColor(issue.severity)}`}
                    >
                      {getSeverityLabel(issue.severity, t)}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{issue.metric}</p>
                      <p className="text-sm text-muted-foreground">{issue.description}</p>
                      {issue.score != null && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('resultDetail.score')}: {(issue.score * 100).toFixed(1)}%
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          {analysis.suggestions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                {t('resultDetail.suggestions')}
              </h4>
              <div className="space-y-2">
                {analysis.suggestions.map((suggestion, i) => (
                  <div key={i} className="rounded bg-blue-50 p-3">
                    <p className="text-sm font-medium text-blue-900">{suggestion.title}</p>
                    <p className="text-sm text-blue-700 mt-1">{suggestion.description}</p>
                    {suggestion.related_metrics.length > 0 && (
                      <p className="text-xs text-blue-600 mt-1">
                        {t('resultDetail.relatedMetrics')}: {suggestion.related_metrics.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Priority Order */}
          {analysis.priority_order.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-1">
                {t('resultDetail.priorityOrder')}
              </h4>
              <p className="text-sm">{analysis.priority_order.join(' → ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CrossValidationCard({
  results,
  t,
}: {
  results: ResultDetail['cross_validation_results']
  t: (key: string) => string
}) {
  if (!results || !results.pairs) return null

  const hasAlert = results.has_alert

  return (
    <div
      className={`rounded-lg border-2 overflow-hidden ${
        hasAlert ? 'border-red-300 bg-red-50/30' : 'border-green-300 bg-green-50/30'
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between p-4 ${
          hasAlert ? 'bg-red-100/50' : 'bg-green-100/50'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`rounded-full p-2 ${hasAlert ? 'bg-red-200' : 'bg-green-200'}`}
          >
            {hasAlert ? (
              <ShieldAlert className={`h-5 w-5 ${hasAlert ? 'text-red-700' : 'text-green-700'}`} />
            ) : (
              <ShieldCheck className="h-5 w-5 text-green-700" />
            )}
          </div>
          <div>
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <GitCompare className="h-5 w-5" />
              {t('resultDetail.crossValidation')}
            </h3>
            <p className="text-sm text-muted-foreground">
              RAGAS vs TruLens {t('resultDetail.frameworkComparison')}
            </p>
          </div>
        </div>
        <div className="text-right">
          {hasAlert ? (
            <div className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" />
              <span className="font-medium">
                {results.alert_count} {t('resultDetail.alertsDetected')}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">{t('resultDetail.allPassed')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="p-4">
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="text-left p-3 font-medium">{t('resultDetail.pairName')}</th>
                <th className="text-left p-3 font-medium">{t('resultDetail.evalTarget')}</th>
                <th className="text-center p-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    RAGAS
                  </span>
                </th>
                <th className="text-center p-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                    TruLens
                  </span>
                </th>
                <th className="text-center p-3 font-medium">{t('resultDetail.difference')}</th>
                <th className="text-center p-3 font-medium">{t('resultDetail.status')}</th>
              </tr>
            </thead>
            <tbody>
              {results.pairs.map((pair, i) => (
                <tr
                  key={i}
                  className={`border-b last:border-b-0 ${
                    pair.is_alert ? 'bg-red-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="p-3">
                    <span className="font-medium">{pair.name}</span>
                  </td>
                  <td className="p-3 text-muted-foreground">{pair.eval_target}</td>
                  <td className="p-3 text-center">
                    <span
                      className={`inline-block min-w-[60px] px-2 py-1 rounded font-medium ${
                        pair.ragas_score != null && pair.ragas_score >= 0.7
                          ? 'bg-green-100 text-green-700'
                          : pair.ragas_score != null && pair.ragas_score >= 0.5
                            ? 'bg-yellow-100 text-yellow-700'
                            : pair.ragas_score != null
                              ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {pair.ragas_score != null
                        ? (pair.ragas_score * 100).toFixed(1) + '%'
                        : '-'}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    <span
                      className={`inline-block min-w-[60px] px-2 py-1 rounded font-medium ${
                        pair.trulens_score != null && pair.trulens_score >= 0.7
                          ? 'bg-blue-100 text-blue-700'
                          : pair.trulens_score != null && pair.trulens_score >= 0.5
                            ? 'bg-yellow-100 text-yellow-700'
                            : pair.trulens_score != null
                              ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {pair.trulens_score != null
                        ? (pair.trulens_score * 100).toFixed(1) + '%'
                        : '-'}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    <span
                      className={`inline-block min-w-[60px] px-2 py-1 rounded font-medium ${
                        pair.is_alert
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {pair.difference != null
                        ? (pair.difference * 100).toFixed(1) + '%'
                        : '-'}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    {pair.is_alert ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-700">
                        <AlertTriangle className="h-4 w-4" />
                        {t('resultDetail.alert')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-100 text-green-700">
                        <CheckCircle className="h-4 w-4" />
                        {t('resultDetail.pass')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t('resultDetail.alertThreshold')}: {(results.threshold * 100).toFixed(0)}%{' '}
            {t('resultDetail.difference')}
          </span>
          <span>
            {t('resultDetail.totalPairs')}: {results.pairs.length}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function ResultDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { t } = useTranslation()
  const [result, setResult] = useState<ResultDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reEvaluating, setReEvaluating] = useState(false)

  const fetchDetail = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getEvaluationResultDetail(parseInt(id))
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch detail')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDetail()
  }, [id])

  const handleReEvaluate = async () => {
    if (!result) return
    setReEvaluating(true)
    try {
      const jobResult = await triggerEvaluation('ids', {
        record_ids: [result.conversation_record_id],
      })

      // Poll for completion
      const pollStatus = async () => {
        const statusResult = await getEvaluationStatus(jobResult.job_id)
        if (statusResult.status === 'completed' || statusResult.status === 'failed') {
          setReEvaluating(false)
          fetchDetail()
        } else {
          setTimeout(pollStatus, 2000)
        }
      }
      pollStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-evaluate')
      setReEvaluating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">{t('common.loading')}</span>
      </div>
    )
  }

  if (error || !result) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/results" className="rounded-md p-2 hover:bg-secondary">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-semibold">{t('common.error')}</h1>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error || 'Result not found'}
        </div>
      </div>
    )
  }

  // Prepare scores record for tiered metrics
  const scores: Record<string, number | undefined> = {
    ragas_query_context_relevance: result.ragas_query_context_relevance,
    trulens_context_relevance: result.trulens_context_relevance,
    faithfulness_score: result.faithfulness_score,
    trulens_groundedness: result.trulens_groundedness,
    answer_relevancy_score: result.answer_relevancy_score,
    trulens_relevance_llm: result.trulens_relevance_llm,
    ragas_context_precision_emb: result.ragas_context_precision_emb,
    ragas_context_diversity: result.ragas_context_diversity,
    ragas_context_utilization: result.ragas_context_utilization,
    context_precision_score: result.context_precision_score,
    ragas_coherence: result.ragas_coherence,
    trulens_coherence: result.trulens_coherence,
    trulens_harmlessness: result.trulens_harmlessness,
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/results" className="rounded-md p-2 hover:bg-secondary">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-semibold">
            {t('results.title')} #{result.id}
          </h1>
          {result.has_cv_alert && (
            <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {t('resultDetail.cvAlert')}
            </span>
          )}
        </div>
        <button
          onClick={handleReEvaluate}
          disabled={reEvaluating}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {reEvaluating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          {t('results.reEvaluate')}
        </button>
      </div>

      {/* Total Score Card - Most Prominent */}
      <TotalScoreCard
        totalScore={result.total_score}
        retrievalScore={result.retrieval_score}
        generationScore={result.generation_score}
        isFailed={result.is_failed}
        failureReason={result.failure_reason}
        size="lg"
      />

      {/* Tiered Metrics Sections */}
      <TieredMetricsSection
        tier="core"
        title={t('metrics.tiers.core', 'Core Metrics (Tier 1)')}
        icon={<Target className="h-5 w-5 text-primary" />}
        defaultExpanded={true}
        scores={scores}
        showThresholdWarning={true}
      />

      <TieredMetricsSection
        tier="key"
        title={t('metrics.tiers.key', 'Key Metrics (Tier 2)')}
        icon={<Zap className="h-5 w-5 text-yellow-600" />}
        defaultExpanded={false}
        scores={scores}
      />

      <TieredMetricsSection
        tier="diagnostic"
        title={t('metrics.tiers.diagnostic', 'Diagnostic Metrics (Tier 3)')}
        icon={<Search className="h-5 w-5 text-muted-foreground" />}
        defaultExpanded={false}
        scores={scores}
      />

      {/* Cross-validation Results */}
      {result.cross_validation_results && (
        <CrossValidationCard results={result.cross_validation_results} t={t} />
      )}

      {/* Legacy Overall Scores (for backward compatibility) */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">
          {t('resultDetail.legacyScores', 'Legacy Scores')}
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <ScoreCard
            title={t('results.faithfulness')}
            score={result.faithfulness_score ?? undefined}
          />
          <ScoreCard
            title={t('results.answerRelevancy')}
            score={result.answer_relevancy_score ?? undefined}
          />
          <ScoreCard
            title={t('results.contextPrecision')}
            score={result.context_precision_score ?? undefined}
          />
          <ScoreCard
            title={t('results.overall')}
            score={result.overall_score ?? undefined}
          />
        </div>
      </div>

      {/* Diagnostic Analyses */}
      {(result.ragas_analysis || result.trulens_analysis || result.overall_analysis) && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{t('resultDetail.diagnosticAnalysis')}</h2>

          {result.ragas_analysis && (
            <DiagnosticCard
              analysis={result.ragas_analysis}
              title={`RAGAS ${t('resultDetail.analysis')}`}
              t={t}
              icon={
                <div className="rounded-full bg-green-100 p-2">
                  <Cpu className="h-4 w-4 text-green-600" />
                </div>
              }
            />
          )}

          {result.trulens_analysis && (
            <DiagnosticCard
              analysis={result.trulens_analysis}
              title={`TruLens ${t('resultDetail.analysis')}`}
              t={t}
              icon={
                <div className="rounded-full bg-blue-100 p-2">
                  <Brain className="h-4 w-4 text-blue-600" />
                </div>
              }
            />
          )}

          {result.overall_analysis && (
            <DiagnosticCard
              analysis={result.overall_analysis}
              title={t('resultDetail.overallAnalysis')}
              t={t}
              icon={
                <div className="rounded-full bg-purple-100 p-2">
                  <CheckCircle className="h-4 w-4 text-purple-600" />
                </div>
              }
            />
          )}
        </div>
      )}

      {/* Conversation */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* User Prompt */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
            {t('results.userPrompt')}
          </h3>
          <p className="text-sm">{result.user_prompt}</p>
        </div>

        {/* Knowledge Base Info */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
            {t('results.knowledgeBase')} Info
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('results.knowledgeBase')}:</span>
              <span>{result.knowledge_name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('results.retriever')}:</span>
              <span>{result.retriever_name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('results.embeddingModel')}:</span>
              <span>{result.embedding_model || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('results.retrievalMode')}:</span>
              <span>{result.retrieval_mode || '-'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Assistant Answer */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
          {t('results.assistantAnswer')}
        </h3>
        <div className="whitespace-pre-wrap text-sm">{result.assistant_answer}</div>
      </div>

      {/* Extracted Text */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
          {t('results.extractedText')}
        </h3>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-secondary p-3 text-sm">
          {result.extracted_text || t('common.noData')}
        </pre>
      </div>

      {/* Legacy LLM Analysis */}
      {result.llm_analysis && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{t('results.analysis')}</h2>

          {/* Quality Assessment */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
              {t('resultDetail.qualityAssessment')}
            </h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t('resultDetail.overallQuality')}:</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                    result.llm_analysis.quality_assessment.overall_quality === 'good'
                      ? 'bg-green-100 text-green-700'
                      : result.llm_analysis.quality_assessment.overall_quality === 'acceptable'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-red-100 text-red-700'
                  }`}
                >
                  {result.llm_analysis.quality_assessment.overall_quality}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">{t('resultDetail.accuracy')}: </span>
                {result.llm_analysis.quality_assessment.answer_accuracy}
              </div>
              <div>
                <span className="text-muted-foreground">{t('resultDetail.completeness')}: </span>
                {result.llm_analysis.quality_assessment.answer_completeness}
              </div>
              {result.llm_analysis.quality_assessment.strengths?.length > 0 && (
                <div>
                  <span className="text-muted-foreground">{t('resultDetail.strengths')}: </span>
                  <ul className="ml-4 list-disc">
                    {result.llm_analysis.quality_assessment.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.llm_analysis.quality_assessment.weaknesses?.length > 0 && (
                <div>
                  <span className="text-muted-foreground">{t('resultDetail.weaknesses')}: </span>
                  <ul className="ml-4 list-disc">
                    {result.llm_analysis.quality_assessment.weaknesses.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Improvement Suggestions */}
          {result.llm_analysis.improvement_suggestions?.length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
                {t('results.suggestions')}
              </h3>
              <div className="space-y-2">
                {result.llm_analysis.improvement_suggestions.map((s, i) => (
                  <div key={i} className="flex items-start gap-3 rounded bg-secondary p-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        s.priority === 'high'
                          ? 'bg-red-100 text-red-700'
                          : s.priority === 'medium'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {s.priority.toUpperCase()}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm">{s.suggestion}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('resultDetail.category')}: {s.category} | {t('resultDetail.impact')}:{' '}
                        {s.expected_impact}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
              {t('resultDetail.summary')}
            </h3>
            <p className="text-sm">{result.llm_analysis.summary}</p>
          </div>
        </div>
      )}
    </div>
  )
}
