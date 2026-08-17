// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import { buildLinePoints, DailyUsageChart } from '../DailyUsageChart'

describe('buildLinePoints', () => {
  test('plots daily values from left to right', () => {
    const points = buildLinePoints(
      [
        { date: '2026-08-10', pv: 2, uv: 1 },
        { date: '2026-08-11', pv: 4, uv: 3 },
      ],
      'pv',
      4
    )

    expect(points).toBe('52.00,108.00 784.00,16.00')
  })

  test('centers a single day', () => {
    const points = buildLinePoints([{ date: '2026-08-10', pv: 0, uv: 0 }], 'uv', 1)

    expect(points).toBe('418.00,200.00')
  })
})

describe('DailyUsageChart', () => {
  test('toggles a series from its legend button', () => {
    render(
      <DailyUsageChart
        rows={[
          {
            date: '2026-08-10',
            agent_name: 'Agent A',
            agent_namespace: 'default',
            pv: 2,
            uv: 1,
          },
          {
            date: '2026-08-11',
            agent_name: 'Agent A',
            agent_namespace: 'default',
            pv: 4,
            uv: 3,
          },
        ]}
        showAiMetrics={false}
        labels={{
          usageTrend: 'Task usage trend',
          aiTrend: 'AI conversation trend',
          pv: 'PV',
          uv: 'UV',
          aiRounds: 'AI rounds',
          completedAiRounds: 'Completed AI rounds',
          selectAgents: 'Select chart agents',
          shownAgents: 'Showing {{shown}} / {{total}}',
          topAgents: 'Reset to top 5',
          selectAll: 'Select all',
          clearAll: 'Clear all',
        }}
      />
    )

    const pvToggle = screen.getByTestId('agent-usage-toggle-pv')
    expect(screen.getByTestId('agent-usage-series-pv-0')).toBeInTheDocument()

    fireEvent.click(pvToggle)
    expect(pvToggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('agent-usage-series-pv-0')).not.toBeInTheDocument()

    fireEvent.click(pvToggle)
    expect(pvToggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('agent-usage-series-pv-0')).toBeInTheDocument()
  })

  test('toggles all metrics for an agent', () => {
    render(
      <DailyUsageChart
        rows={[
          {
            date: '2026-08-10',
            agent_name: 'Agent A',
            agent_namespace: 'default',
            pv: 2,
            uv: 1,
          },
          {
            date: '2026-08-10',
            agent_name: 'Agent B',
            agent_namespace: 'default',
            pv: 3,
            uv: 2,
          },
        ]}
        showAiMetrics={false}
        labels={{
          usageTrend: 'Task usage trend',
          aiTrend: 'AI conversation trend',
          pv: 'PV',
          uv: 'UV',
          aiRounds: 'AI rounds',
          completedAiRounds: 'Completed AI rounds',
          selectAgents: 'Select chart agents',
          shownAgents: 'Showing {{shown}} / {{total}}',
          topAgents: 'Reset to top 5',
          selectAll: 'Select all',
          clearAll: 'Clear all',
        }}
      />
    )

    fireEvent.click(screen.getByTestId('agent-usage-chart-agent-select'))
    fireEvent.click(screen.getByTestId('agent-usage-chart-agent-option-0'))

    expect(screen.getByTestId('agent-usage-chart-agent-select')).toHaveTextContent('Showing 1 / 2')
    expect(screen.getAllByTestId(/agent-usage-series-pv-/)).toHaveLength(1)
    expect(screen.getAllByTestId(/agent-usage-series-uv-/)).toHaveLength(1)
  })

  test('clears all agents and selects all on the next click', () => {
    render(
      <DailyUsageChart
        rows={[
          {
            date: '2026-08-10',
            agent_name: 'Agent A',
            agent_namespace: 'default',
            pv: 2,
            uv: 1,
          },
          {
            date: '2026-08-10',
            agent_name: 'Agent B',
            agent_namespace: 'default',
            pv: 3,
            uv: 2,
          },
        ]}
        showAiMetrics={false}
        labels={{
          usageTrend: 'Task usage trend',
          aiTrend: 'AI conversation trend',
          pv: 'PV',
          uv: 'UV',
          aiRounds: 'AI rounds',
          completedAiRounds: 'Completed AI rounds',
          selectAgents: 'Select chart agents',
          shownAgents: 'Showing {{shown}} / {{total}}',
          topAgents: 'Reset to top 5',
          selectAll: 'Select all',
          clearAll: 'Clear all',
        }}
      />
    )

    fireEvent.click(screen.getByTestId('agent-usage-chart-agent-select'))
    const selectAll = screen.getByTestId('agent-usage-chart-select-all')
    expect(selectAll).toHaveTextContent('Clear all')

    fireEvent.click(selectAll)
    expect(screen.getByTestId('agent-usage-chart-agent-select')).toHaveTextContent('Showing 0 / 2')
    expect(screen.queryAllByTestId(/agent-usage-series-pv-/)).toHaveLength(0)

    fireEvent.click(screen.getByTestId('agent-usage-chart-select-all'))
    expect(screen.getByTestId('agent-usage-chart-agent-select')).toHaveTextContent('Showing 2 / 2')
    expect(screen.getAllByTestId(/agent-usage-series-pv-/)).toHaveLength(2)
  })
})
