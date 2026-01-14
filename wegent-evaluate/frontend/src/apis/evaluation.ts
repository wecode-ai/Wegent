/**
 * API client for evaluation endpoints
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:18000'

export async function triggerEvaluation(
  mode: 'range' | 'ids',
  options: { start_id?: number; end_id?: number; record_ids?: number[]; force?: boolean }
) {
  const response = await fetch(`${API_BASE_URL}/api/evaluation/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, ...options }),
  })
  if (!response.ok) throw new Error('Failed to trigger evaluation')
  return response.json()
}

export async function getEvaluationStatus(jobId: string) {
  const response = await fetch(`${API_BASE_URL}/api/evaluation/status/${jobId}`)
  if (!response.ok) throw new Error('Failed to get evaluation status')
  return response.json()
}

export async function getEvaluationResults(params: {
  page?: number
  page_size?: number
  start_date?: string
  end_date?: string
  has_issue?: boolean
  has_cv_alert?: boolean
  min_score?: number
  max_score?: number
  retriever_name?: string
  embedding_model?: string
  knowledge_id?: number
  evaluation_status?: string
  issue_type?: string
  version_id?: number
}) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.append(key, String(value))
    }
  })

  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/results?${searchParams.toString()}`
  )
  if (!response.ok) throw new Error('Failed to get evaluation results')
  return response.json()
}

export async function getEvaluationResultDetail(resultId: number) {
  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/results/${resultId}`
  )
  if (!response.ok) throw new Error('Failed to get evaluation result detail')
  return response.json()
}

export async function getEvaluationSummary(params: {
  start_date?: string
  end_date?: string
  version_id?: number
}) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  })

  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/summary?${searchParams.toString()}`
  )
  if (!response.ok) throw new Error('Failed to get evaluation summary')
  return response.json()
}

export async function getEvaluationAlerts(params: {
  page?: number
  page_size?: number
  threshold?: number
}) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  })

  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/alerts?${searchParams.toString()}`
  )
  if (!response.ok) throw new Error('Failed to get evaluation alerts')
  return response.json()
}

export async function getMetricsDocumentation(params?: {
  framework?: 'ragas' | 'trulens'
  signal_source?: 'embedding' | 'llm'
}) {
  const searchParams = new URLSearchParams()
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value))
      }
    })
  }

  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/metrics-docs?${searchParams.toString()}`
  )
  if (!response.ok) throw new Error('Failed to get metrics documentation')
  return response.json()
}

export async function getMetricDocumentationById(metricId: string) {
  const response = await fetch(
    `${API_BASE_URL}/api/evaluation/metrics-docs/${metricId}`
  )
  if (!response.ok) throw new Error('Failed to get metric documentation')
  return response.json()
}
