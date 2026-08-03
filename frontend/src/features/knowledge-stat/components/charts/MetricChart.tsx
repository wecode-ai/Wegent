// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type MetricResponse } from '../../api'
import { BarChart } from './BarChart'
import { DataTable } from './DataTable'
import { HealthScoreTable } from './HealthScoreTable'
import { HealthScoreTrendTable } from './HealthScoreTrendTable'
import { KbRadarChart } from './KbRadarChart'
import { KbStackedBarChart } from './KbStackedBarChart'
import { LineChart } from './LineChart'
import { PieChart } from './PieChart'
import { SummaryCards } from './SummaryCards'

/* -------------------------------------------------------------------------- */
/*  Metric Chart — router                                                      */
/* -------------------------------------------------------------------------- */

export function MetricChart({
  response,
  chartHint,
}: {
  response: MetricResponse
  chartHint?: string
}) {
  const hint = chartHint || _inferChartHint(response)

  switch (hint) {
    case 'line':
      return <LineChart rows={response.rows} schema={response.schema} />
    case 'bar':
      return <BarChart rows={response.rows} schema={response.schema} />
    case 'pie':
      return <PieChart rows={response.rows} schema={response.schema} />
    case 'cards':
      return <SummaryCards rows={response.rows} schema={response.schema} />
    case 'stacked_bar':
      return <KbStackedBarChart rows={response.rows} schema={response.schema} />
    case 'radar':
      return <KbRadarChart rows={response.rows} schema={response.schema} />
    case 'health_table':
      return <HealthScoreTable response={response} />
    case 'health_trend_table':
      return <HealthScoreTrendTable response={response} />
    default:
      return <DataTable rows={response.rows} schema={response.schema} />
  }
}

function _inferChartHint(response: MetricResponse): string {
  const hasDate = response.schema.some(s => s.type === 'date')
  const numericFields = response.schema.filter(s => s.type === 'int' || s.type === 'float')
  if (hasDate && numericFields.length > 0) {
    return 'line'
  }
  if (numericFields.length > 0 && !hasDate) {
    const stringFields = response.schema.filter(s => s.type === 'string')
    if (stringFields.length > 0) {
      return 'bar'
    }
  }
  return 'table'
}
