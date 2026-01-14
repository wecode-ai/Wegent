/**
 * API client for report endpoints
 */
import type { WeeklyReportRequest, WeeklyReportResponse } from '@/types'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:18000'

export async function generateWeeklyReport(params: WeeklyReportRequest): Promise<WeeklyReportResponse> {
  const response = await fetch(`${API_BASE_URL}/api/reports/weekly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to generate report')
  }
  return response.json()
}
