/**
 * Type definitions for Wegent Evaluate
 */

// Evaluation Status
export type EvaluationStatus =
  | 'pending'
  | 'skipped'
  | 'processing'
  | 'completed'
  | 'failed'

// Sync Status
export type SyncStatus = 'started' | 'running' | 'completed' | 'failed'

// Sync Job
export interface SyncJob {
  sync_id: string
  start_time: string
  end_time: string
  user_id?: number
  version_id?: number
  status: SyncStatus
  total_fetched: number
  total_inserted: number
  total_skipped: number
  error_message?: string
  created_at: string
  updated_at: string
}

// Data Version
export interface DataVersion {
  id: number
  name: string
  description?: string
  created_at: string
  last_sync_time?: string
  sync_count: number
}

// Sync Trigger Request
export interface SyncTriggerRequest {
  start_time: string
  end_time: string
  user_id?: number
  version_mode: 'new' | 'existing'
  version_id?: number
  write_mode?: 'append' | 'replace'
  version_description?: string
}

// Weekly Report Request
export interface WeeklyReportRequest {
  version_id: number
}

// Weekly Report Response
export interface WeeklyReportResponse {
  markdown: string
  generated_at: string
  version_id: number
  version_name: string
}

// ========== Metrics Tiered System ==========

// Metric tier types
export type MetricTier = 'core' | 'key' | 'diagnostic'

// Framework types
export type MetricFramework = 'ragas' | 'trulens'

// Signal source types
export type SignalSource = 'embedding' | 'llm'

// Metric metadata interface
export interface MetricMeta {
  name: string                    // Display name
  key: string                     // Field key name
  tier: MetricTier                // Tier level
  framework: MetricFramework      // Framework source
  signalSource: SignalSource      // Signal source
  weight?: number                 // Weight in total score formula
  crossValidationPair?: string    // Cross-validation pair metric key
  description?: string            // Description
  descriptionZh?: string          // Chinese description
}

// Complete metrics configuration
export const METRICS_CONFIG: MetricMeta[] = [
  // ========== Core Metrics (Tier 1) ==========
  {
    name: 'Query Context Relevance',
    key: 'ragas_query_context_relevance',
    tier: 'core',
    framework: 'ragas',
    signalSource: 'embedding',
    weight: 0.25,
    crossValidationPair: 'trulens_context_relevance',
    description: 'Retrieval relevance',
    descriptionZh: '检索是否对题'
  },
  {
    name: 'Context Relevance',
    key: 'trulens_context_relevance',
    tier: 'core',
    framework: 'trulens',
    signalSource: 'embedding',
    weight: 0.15,
    crossValidationPair: 'ragas_query_context_relevance',
    description: 'Cross validation',
    descriptionZh: '交叉验证'
  },
  {
    name: 'Faithfulness',
    key: 'faithfulness_score',
    tier: 'core',
    framework: 'ragas',
    signalSource: 'llm',
    weight: 0.30,
    crossValidationPair: 'trulens_groundedness',
    description: 'Hallucination check',
    descriptionZh: '是否幻觉'
  },
  {
    name: 'Groundedness',
    key: 'trulens_groundedness',
    tier: 'core',
    framework: 'trulens',
    signalSource: 'llm',
    weight: 0.20,
    crossValidationPair: 'faithfulness_score',
    description: 'Cross validation',
    descriptionZh: '交叉验证'
  },

  // ========== Key Metrics (Tier 2) ==========
  {
    name: 'Answer Relevancy',
    key: 'answer_relevancy_score',
    tier: 'key',
    framework: 'ragas',
    signalSource: 'llm',
    weight: 0.05,
    crossValidationPair: 'trulens_relevance_llm',
    description: 'Answer relevance check',
    descriptionZh: '是否答非所问'
  },
  {
    name: 'Relevance (LLM)',
    key: 'trulens_relevance_llm',
    tier: 'key',
    framework: 'trulens',
    signalSource: 'llm',
    crossValidationPair: 'answer_relevancy_score',
    description: 'Judge comparison',
    descriptionZh: '与上面形成 judge 对照'
  },
  {
    name: 'Context Precision (Embedding)',
    key: 'ragas_context_precision_emb',
    tier: 'key',
    framework: 'ragas',
    signalSource: 'embedding',
    weight: 0.05,
    description: 'Retrieval noise check',
    descriptionZh: '检索是否夹杂噪音'
  },

  // ========== Diagnostic Metrics (Tier 3) ==========
  {
    name: 'Context Diversity',
    key: 'ragas_context_diversity',
    tier: 'diagnostic',
    framework: 'ragas',
    signalSource: 'embedding',
    description: 'Structural metric',
    descriptionZh: '结构指标，用户无感'
  },
  {
    name: 'Context Utilization',
    key: 'ragas_context_utilization',
    tier: 'diagnostic',
    framework: 'ragas',
    signalSource: 'llm',
    description: 'Correlated with groundedness',
    descriptionZh: '与 groundedness 强相关'
  },
  {
    name: 'Context Precision (LLM)',
    key: 'context_precision_score',
    tier: 'diagnostic',
    framework: 'ragas',
    signalSource: 'llm',
    description: 'Subjective, redundant',
    descriptionZh: '主观、冗余'
  },
  {
    name: 'Coherence',
    key: 'ragas_coherence',
    tier: 'diagnostic',
    framework: 'ragas',
    signalSource: 'llm',
    crossValidationPair: 'trulens_coherence',
    description: 'Expression quality ≠ RAG quality',
    descriptionZh: '表达质量 ≠ RAG 质量'
  },
  {
    name: 'Coherence',
    key: 'trulens_coherence',
    tier: 'diagnostic',
    framework: 'trulens',
    signalSource: 'llm',
    crossValidationPair: 'ragas_coherence',
    description: 'Expression quality ≠ RAG quality',
    descriptionZh: '表达质量 ≠ RAG 质量'
  },
  {
    name: 'Harmlessness',
    key: 'trulens_harmlessness',
    tier: 'diagnostic',
    framework: 'trulens',
    signalSource: 'llm',
    description: 'Safety ≠ RAG effectiveness',
    descriptionZh: '安全 ≠ RAG 效果'
  },
]

// Helper function: Get metrics by tier
export const getMetricsByTier = (tier: MetricTier): MetricMeta[] =>
  METRICS_CONFIG.filter(m => m.tier === tier)

// Helper function: Get cross-validation pairs
export const getCrossValidationPairs = (tier: MetricTier): Array<[MetricMeta, MetricMeta]> => {
  const metrics = getMetricsByTier(tier)
  const pairs: Array<[MetricMeta, MetricMeta]> = []
  const processed = new Set<string>()

  metrics.forEach(metric => {
    if (metric.crossValidationPair && !processed.has(metric.key)) {
      const pair = metrics.find(m => m.key === metric.crossValidationPair)
      if (pair) {
        // Ensure RAGAS is first
        if (metric.framework === 'ragas') {
          pairs.push([metric, pair])
        } else {
          pairs.push([pair, metric])
        }
        processed.add(metric.key)
        processed.add(pair.key)
      }
    }
  })

  return pairs
}

// Helper function: Get standalone metrics (no cross-validation pair)
export const getStandaloneMetrics = (tier: MetricTier): MetricMeta[] =>
  getMetricsByTier(tier).filter(m => !m.crossValidationPair)

// Helper function: Get all cross-validation pairs across all tiers
export const getAllCrossValidationPairs = (): Array<[MetricMeta, MetricMeta]> => {
  const allPairs: Array<[MetricMeta, MetricMeta]> = []
  const tiers: MetricTier[] = ['core', 'key', 'diagnostic']
  tiers.forEach(tier => {
    allPairs.push(...getCrossValidationPairs(tier))
  })
  return allPairs
}

// Helper function: Calculate total score
export const calculateTotalScore = (scores: Record<string, number | undefined | null>): {
  totalScore: number
  retrievalScore: number
  generationScore: number
  isFailed: boolean
  failureReason: string | null
} => {
  // Retrieval Score (45%)
  const retrievalScore =
    0.25 * (scores.ragas_query_context_relevance || 0) +
    0.15 * (scores.trulens_context_relevance || 0) +
    0.05 * (scores.ragas_context_precision_emb || 0)

  // Generation Score (55%)
  const generationScore =
    0.30 * (scores.faithfulness_score || 0) +
    0.20 * (scores.trulens_groundedness || 0) +
    0.05 * (scores.answer_relevancy_score || 0)

  const totalScore = 100 * (retrievalScore + generationScore)

  // Hard threshold check
  const faithfulness = scores.faithfulness_score || 0
  const groundedness = scores.trulens_groundedness || 0
  let isFailed = false
  const reasons: string[] = []

  if (faithfulness < 0.6) {
    isFailed = true
    reasons.push(`Faithfulness (${(faithfulness * 100).toFixed(1)}%) < 60%`)
  }
  if (groundedness < 0.6) {
    isFailed = true
    reasons.push(`Groundedness (${(groundedness * 100).toFixed(1)}%) < 60%`)
  }

  return {
    totalScore,
    retrievalScore,
    generationScore,
    isFailed,
    failureReason: reasons.length > 0 ? reasons.join('; ') : null
  }
}

// Evaluation Result
export interface EvaluationResultItem {
  id: number
  conversation_record_id: number
  user_prompt: string
  assistant_answer: string
  extracted_text?: string
  faithfulness_score?: number
  answer_relevancy_score?: number
  context_precision_score?: number
  overall_score?: number
  has_issue: boolean
  has_cv_alert?: boolean
  issue_types?: string[]
  retriever_name?: string
  embedding_model?: string
  knowledge_name?: string
  evaluation_status: EvaluationStatus
  created_at: string
  // New fields for tiered metrics
  total_score?: number
  retrieval_score?: number
  generation_score?: number
  is_failed?: boolean
  failure_reason?: string
  // TruLens groundedness for list view (事实性)
  trulens_groundedness?: number
}

// Evaluation Result Detail with all metrics
export interface EvaluationResultDetail extends EvaluationResultItem {
  knowledge_id?: number
  retrieval_mode?: string
  knowledge_base_result?: Record<string, unknown>
  knowledge_base_config?: Record<string, unknown>
  // RAGAS Embedding metrics
  ragas_query_context_relevance?: number
  ragas_context_precision_emb?: number
  ragas_context_diversity?: number
  // RAGAS LLM metrics
  ragas_context_utilization?: number
  ragas_coherence?: number
  // TruLens Embedding metrics
  trulens_context_relevance?: number
  trulens_relevance_embedding?: number
  // TruLens LLM metrics
  trulens_groundedness?: number
  trulens_relevance_llm?: number
  trulens_coherence?: number
  trulens_harmlessness?: number
  // Cross-validation
  cross_validation_results?: CrossValidationResult
  has_cross_validation_alert?: boolean
  // Diagnostic analyses
  ragas_analysis?: DiagnosticAnalysis
  trulens_analysis?: DiagnosticAnalysis
  overall_analysis?: DiagnosticAnalysis
  // Legacy
  llm_analysis?: LLMAnalysis
  llm_suggestions?: string
  evaluation_model?: string
  evaluation_duration_ms?: number
  original_created_at: string
}

// LLM Analysis
export interface LLMAnalysis {
  quality_assessment: {
    overall_quality: 'good' | 'acceptable' | 'poor'
    answer_accuracy: string
    answer_completeness: string
    strengths: string[]
    weaknesses: string[]
  }
  retrieval_diagnosis: {
    retrieval_quality: 'good' | 'acceptable' | 'poor'
    relevance_analysis: string
    coverage_analysis: string
    issues: string[]
    root_cause?: string
  }
  improvement_suggestions: {
    category: string
    suggestion: string
    priority: 'high' | 'medium' | 'low'
    expected_impact: string
  }[]
  has_critical_issue: boolean
  issue_types: string[]
  summary: string
}

// Cross-validation types
export interface CrossValidationPair {
  name: string
  ragas_metric: string
  trulens_metric: string
  eval_target: string
  signal_source: string
  scoring_goal: string
  ragas_score?: number
  trulens_score?: number
  difference?: number
  is_alert: boolean
  threshold: number
}

export interface CrossValidationResult {
  pairs: CrossValidationPair[]
  has_alert: boolean
  alert_count: number
  threshold: number
}

// Diagnostic Analysis
export interface DiagnosticIssue {
  metric: string
  score?: number
  description: string
  severity: 'high' | 'medium' | 'low'
}

export interface DiagnosticSuggestion {
  title: string
  description: string
  related_metrics: string[]
}

export interface DiagnosticAnalysis {
  framework: string
  overall_rating: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'
  has_issues: boolean
  issues: DiagnosticIssue[]
  suggestions: DiagnosticSuggestion[]
  priority_order: string[]
  summary: string
  raw_analysis?: string
}

// Evaluation Alert
export interface EvaluationAlert {
  id: number
  evaluation_id: number
  pair_name: string
  eval_target?: string
  signal_source?: string
  scoring_goal?: string
  ragas_metric?: string
  trulens_metric?: string
  ragas_score?: number
  trulens_score?: number
  difference?: number
  threshold?: number
  created_at: string
}

// Evaluation Summary
export interface EvaluationSummary {
  total_evaluated: number
  avg_faithfulness?: number
  avg_answer_relevancy?: number
  avg_context_precision?: number
  avg_overall?: number
  issue_count: number
  issue_rate: number
  cv_alert_count?: number
  cv_alert_rate?: number
  // New fields for tiered metrics
  avg_total_score?: number
  failed_count?: number
  failed_rate?: number
  // Core metrics averages
  avg_ragas_query_context_relevance?: number
  avg_trulens_context_relevance?: number
  avg_trulens_groundedness?: number
  // Key metrics averages
  avg_trulens_relevance_llm?: number
  avg_ragas_context_precision_emb?: number
}

// Metrics Documentation
export interface ScoreInterpretation {
  min: number
  label: string
}

export interface ScoreRange {
  min: number
  max: number
  direction: 'higher_better' | 'lower_better'
}

export interface CrossValidationPairInfo {
  paired_metric: string
  paired_framework: string
}

export interface MetricDocumentation {
  id: string
  name: string
  name_zh: string
  framework: 'ragas' | 'trulens'
  signal_source: 'embedding' | 'llm'
  tier?: MetricTier
  description: string
  description_zh: string
  implementation: string
  implementation_zh: string
  formula?: string
  score_range: ScoreRange
  interpretation: {
    excellent: ScoreInterpretation
    good: ScoreInterpretation
    fair: ScoreInterpretation
    poor: ScoreInterpretation
  }
  cross_validation_pair?: CrossValidationPairInfo
}

// Trend Data Point
export interface TrendDataPoint {
  date: string
  avg_score: number
  count: number
}

// Retriever Comparison
export interface RetrieverComparison {
  retriever_name: string
  avg_faithfulness?: number
  avg_answer_relevancy?: number
  avg_context_precision?: number
  avg_overall?: number
  count: number
}

// Embedding Comparison
export interface EmbeddingComparison {
  embedding_model: string
  avg_faithfulness?: number
  avg_answer_relevancy?: number
  avg_context_precision?: number
  avg_overall?: number
  count: number
}

// Issue Type Count
export interface IssueTypeCount {
  type: string
  count: number
  percentage: number
}

// Pagination
export interface Pagination {
  page: number
  page_size: number
  total: number
  total_pages: number
}

// API Responses
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
}
