/**
 * API client for settings configuration endpoints
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:18000'

export interface SyncConfig {
  external_api_base_url: string
  sync_cron_expression: string
}

export interface EvaluationConfig {
  ragas_llm_model: string
  ragas_embedding_model: string
  evaluation_cron_expression: string
  evaluation_batch_size: number
}

export interface SettingsConfig {
  sync: SyncConfig
  evaluation: EvaluationConfig
}

export async function getSettingsConfig(): Promise<SettingsConfig> {
  const response = await fetch(`${API_BASE_URL}/api/settings/config`)
  if (!response.ok) throw new Error('Failed to get settings config')
  return response.json()
}
