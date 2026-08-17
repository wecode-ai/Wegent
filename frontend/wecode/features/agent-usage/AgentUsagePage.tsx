// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleHelp, Download, Info, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import TopNavigation from '@/features/layout/TopNavigation'
import { useWecodeTranslation } from '@wecode/i18n/useWecodeTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  CollapsedSidebarButtons,
  ResizableSidebar,
  TaskSidebar,
} from '@/features/tasks/components/sidebar'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { paths } from '@/config/paths'
import { agentUsageApi, UsageAgent, UsageResult } from '@wecode/api/agent-usage'
import { UsageDatePicker } from './UsageDatePicker'
import { AgentMultiSelect, agentUsageKey } from './AgentMultiSelect'
import { DailyUsageChart } from './DailyUsageChart'
import { ApiError } from '@/apis/client'

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

const latestDataDateValue = new Date()
latestDataDateValue.setDate(latestDataDateValue.getDate() - 1)
const latestDataDate = formatLocalDate(latestDataDateValue)
const defaultStartDateValue = new Date(latestDataDateValue)
defaultStartDateValue.setDate(defaultStartDateValue.getDate() - 6)
const defaultStartDate = formatLocalDate(defaultStartDateValue)

function MetricLabel({ label, tip }: { label: string; tip?: string }) {
  if (!tip) return <>{label}</>
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <CircleHelp className="h-3.5 w-3.5 cursor-help text-text-muted" />
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </span>
  )
}

export function AgentUsagePage() {
  const { t } = useWecodeTranslation()
  const router = useRouter()
  const isMobile = useIsMobile()
  const { selectTask } = useTaskSession()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [startDate, setStartDate] = useState(defaultStartDate)
  const [endDate, setEndDate] = useState(latestDataDate)
  const [agents, setAgents] = useState<UsageAgent[]>([])
  const [searchingAgents, setSearchingAgents] = useState(false)
  const [agentSearch, setAgentSearch] = useState('')
  const [agentOffset, setAgentOffset] = useState(0)
  const [hasMoreAgents, setHasMoreAgents] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<UsageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const agentRequestId = useRef(0)
  const invalidDateRange = Boolean(startDate && endDate && startDate > endDate)
  const showAiMetrics = result?.ai_rounds !== undefined

  const keyedAgents = useMemo(
    () => agents.map(agent => ({ ...agent, key: agentUsageKey(agent) })),
    [agents]
  )

  useEffect(() => {
    const requestId = ++agentRequestId.current
    agentUsageApi
      .listAgents()
      .then(page => {
        if (requestId !== agentRequestId.current) return
        setAgents(page.items)
        setAgentOffset(page.next_offset)
        setHasMoreAgents(page.has_more)
      })
      .catch(() => {
        if (requestId === agentRequestId.current) {
          setErrorKey('agent_usage.agent_list_error')
        }
      })
  }, [])

  const searchAgents = useCallback((search: string) => {
    const requestId = ++agentRequestId.current
    setAgentSearch(search)
    setSearchingAgents(true)
    agentUsageApi
      .listAgents(search)
      .then(page => {
        if (requestId !== agentRequestId.current) return
        setAgents(previous => {
          const merged = new Map(previous.map(agent => [agentUsageKey(agent), agent]))
          page.items.forEach(agent => merged.set(agentUsageKey(agent), agent))
          return Array.from(merged.values())
        })
        setAgentOffset(page.next_offset)
        setHasMoreAgents(page.has_more)
      })
      .catch(() => {
        if (requestId === agentRequestId.current) {
          setErrorKey('agent_usage.agent_list_error')
        }
      })
      .finally(() => {
        if (requestId === agentRequestId.current) setSearchingAgents(false)
      })
  }, [])

  const loadMoreAgents = useCallback(() => {
    if (searchingAgents || !hasMoreAgents) return
    const requestId = ++agentRequestId.current
    setSearchingAgents(true)
    agentUsageApi
      .listAgents(agentSearch, agentOffset)
      .then(page => {
        if (requestId !== agentRequestId.current) return
        setAgents(previous => {
          const merged = new Map(previous.map(agent => [agentUsageKey(agent), agent]))
          page.items.forEach(agent => merged.set(agentUsageKey(agent), agent))
          return Array.from(merged.values())
        })
        setAgentOffset(page.next_offset)
        setHasMoreAgents(page.has_more)
      })
      .catch(() => {
        if (requestId === agentRequestId.current) {
          setErrorKey('agent_usage.agent_list_error')
        }
      })
      .finally(() => {
        if (requestId === agentRequestId.current) setSearchingAgents(false)
      })
  }, [agentOffset, agentSearch, hasMoreAgents, searchingAgents])

  useEffect(() => {
    setIsCollapsed(localStorage.getItem('task-sidebar-collapsed') === 'true')
  }, [])

  const toggleSidebar = () => {
    setIsCollapsed(previous => {
      const next = !previous
      localStorage.setItem('task-sidebar-collapsed', String(next))
      return next
    })
  }

  const newTask = () => {
    selectTask(null)
    router.replace(paths.chat.getHref())
  }

  const query = async () => {
    if (invalidDateRange) {
      setErrorKey('agent_usage.invalid_date_range')
      return
    }
    setLoading(true)
    setErrorKey(null)
    try {
      const filters = keyedAgents
        .filter(agent => selected.includes(agent.key))
        .map(({ name, namespace, owner_user_id, author_name, is_owner }) => ({
          name,
          namespace,
          owner_user_id,
          author_name,
          is_owner,
        }))
      setResult(await agentUsageApi.query(startDate, endDate, filters))
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setErrorKey('agent_usage.permission_error')
      } else if (error instanceof ApiError && error.status === 400) {
        setErrorKey('agent_usage.invalid_request')
      } else {
        setErrorKey('agent_usage.service_error')
      }
    } finally {
      setLoading(false)
    }
  }

  const downloadExcel = async () => {
    if (!result) return
    const XLSX = await import('xlsx')
    const summaryHeader = [
      t('agent_usage.agent'),
      t('agent_usage.group_name'),
      t('agent_usage.author'),
      'PV',
      'UV',
    ]
    if (showAiMetrics) {
      summaryHeader.push(t('agent_usage.ai_rounds'), t('agent_usage.completed_ai_rounds'))
    }
    const summaryRows = result.rows.map(row => [
      row.agent_name,
      row.agent_namespace,
      row.author_name,
      row.pv,
      row.uv,
      ...(showAiMetrics ? [row.ai_rounds ?? 0, row.completed_ai_rounds ?? 0] : []),
    ])
    summaryRows.push([
      t('agent_usage.total'),
      '',
      '',
      result.pv,
      result.uv,
      ...(showAiMetrics ? [result.ai_rounds ?? 0, result.completed_ai_rounds ?? 0] : []),
    ])
    const detailHeader = [
      t('agent_usage.agent'),
      t('agent_usage.group_name'),
      t('agent_usage.date'),
      'PV',
      'UV',
    ]
    if (showAiMetrics) {
      detailHeader.push(t('agent_usage.ai_rounds'), t('agent_usage.completed_ai_rounds'))
    }
    const detailRows = result.daily_rows.map(row => [
      row.agent_name,
      row.agent_namespace,
      row.date,
      row.pv,
      row.uv,
      ...(showAiMetrics ? [row.ai_rounds ?? 0, row.completed_ai_rounds ?? 0] : []),
    ])

    const summarySheet = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows])
    summarySheet['!cols'] = [
      { wch: 24 },
      { wch: 20 },
      { wch: 18 },
      { wch: 12 },
      { wch: 12 },
      ...(showAiMetrics ? [{ wch: 16 }, { wch: 18 }] : []),
    ]
    const detailSheet = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows])
    detailSheet['!cols'] = [
      { wch: 24 },
      { wch: 20 },
      { wch: 14 },
      { wch: 12 },
      { wch: 12 },
      ...(showAiMetrics ? [{ wch: 16 }, { wch: 18 }] : []),
    ]
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, summarySheet, t('agent_usage.summary_sheet'))
    XLSX.utils.book_append_sheet(workbook, detailSheet, t('agent_usage.detail_sheet'))
    XLSX.writeFile(workbook, `agent-usage-${startDate}-${endDate}.xlsx`)
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={toggleSidebar} onNewTask={newTask} />
      )}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={toggleSidebar}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={toggleSidebar}
        />
      </ResizableSidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavigation
          variant="with-sidebar"
          title={t('agent_usage.title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isCollapsed}
        />
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-7xl space-y-6">
            <header>
              <h2 className="text-xl font-semibold text-text-primary">{t('agent_usage.title')}</h2>
              <p className="mt-1 text-sm text-text-muted">{t('agent_usage.description')}</p>
            </header>

            <section className="rounded-xl border border-border bg-surface">
              <div className="border-b border-border px-5 py-4">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('agent_usage.filters')}
                </h3>
              </div>
              <div className="grid gap-4 px-5 py-5 lg:grid-cols-[180px_180px_minmax(260px,1fr)_auto] lg:items-end">
                <label className="space-y-2 text-sm text-text-secondary">
                  <span>{t('agent_usage.start_date')}</span>
                  <UsageDatePicker
                    value={startDate}
                    onChange={setStartDate}
                    testId="agent-usage-start-date"
                    max={endDate}
                  />
                </label>
                <label className="space-y-2 text-sm text-text-secondary">
                  <span>{t('agent_usage.end_date')}</span>
                  <UsageDatePicker
                    value={endDate}
                    onChange={setEndDate}
                    testId="agent-usage-end-date"
                    min={startDate}
                    max={latestDataDate}
                  />
                </label>
                <div className="space-y-2 text-sm text-text-secondary">
                  <span>{t('agent_usage.agents')}</span>
                  <AgentMultiSelect
                    agents={agents}
                    selected={selected}
                    onChange={setSelected}
                    onSearch={searchAgents}
                    onLoadMore={loadMoreAgents}
                    hasMore={hasMoreAgents}
                    loading={searchingAgents}
                  />
                </div>
                <div className="flex gap-2 lg:justify-end">
                  <Button
                    data-testid="agent-usage-reset"
                    variant="outline"
                    onClick={() => {
                      setStartDate(defaultStartDate)
                      setEndDate(latestDataDate)
                      setSelected([])
                      setErrorKey(null)
                    }}
                  >
                    {t('agent_usage.reset')}
                  </Button>
                  <Button
                    data-testid="agent-usage-query"
                    variant="primary"
                    onClick={query}
                    disabled={loading || !startDate || !endDate || invalidDateRange}
                  >
                    {loading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="mr-2 h-4 w-4" />
                    )}
                    {t('agent_usage.query')}
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-2 border-t border-primary/15 bg-primary/5 px-5 py-3 text-xs font-medium text-primary">
                <Info className="h-4 w-4 shrink-0" />
                {t('agent_usage.t_minus_one_notice')}
              </div>
            </section>

            {(invalidDateRange || errorKey) && (
              <Alert variant="destructive">
                <CircleAlert className="h-4 w-4" />
                <AlertTitle>{t('agent_usage.error_title')}</AlertTitle>
                <AlertDescription>
                  {t(invalidDateRange ? 'agent_usage.invalid_date_range' : (errorKey as string))}
                </AlertDescription>
              </Alert>
            )}
            {result && (
              <Card className="overflow-hidden">
                <Tabs defaultValue="summary">
                  <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">
                        {t('agent_usage.results')}
                      </h3>
                      <TabsList className="mt-3 min-h-11 border border-border-strong bg-muted p-1 md:min-h-9">
                        <TabsTrigger
                          value="summary"
                          data-testid="agent-usage-summary-tab"
                          className="min-h-9 px-4 data-[state=active]:bg-surface data-[state=active]:shadow-sm md:min-h-7"
                        >
                          {t('agent_usage.summary_tab')}
                        </TabsTrigger>
                        <TabsTrigger
                          value="daily"
                          data-testid="agent-usage-daily-tab"
                          className="min-h-9 px-4 data-[state=active]:bg-surface data-[state=active]:shadow-sm md:min-h-7"
                        >
                          {t('agent_usage.daily_details')}
                        </TabsTrigger>
                      </TabsList>
                    </div>
                    <Button
                      data-testid="agent-usage-download"
                      variant="outline"
                      onClick={downloadExcel}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {t('agent_usage.export_excel')}
                    </Button>
                  </div>
                  <TabsContent value="summary" className="mt-0">
                    <p className="border-b border-border px-5 py-3 text-xs text-text-muted">
                      {t('agent_usage.result_count', { count: result.rows.length })}
                    </p>
                    <div className="overflow-x-auto">
                      <Table className="text-left">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="px-4 text-left">
                              {t('agent_usage.agent')}
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              {t('agent_usage.group_name')}
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              {t('agent_usage.author')}
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              <MetricLabel label="PV" tip={t('agent_usage.pv_tip')} />
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              <MetricLabel label="UV" tip={t('agent_usage.uv_tip')} />
                            </TableHead>
                            {showAiMetrics && (
                              <>
                                <TableHead className="px-4 text-left">
                                  {t('agent_usage.ai_rounds')}
                                </TableHead>
                                <TableHead className="px-4 text-left">
                                  {t('agent_usage.completed_ai_rounds')}
                                </TableHead>
                              </>
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.rows.length === 0 ? (
                            <TableRow>
                              <TableCell
                                colSpan={showAiMetrics ? 7 : 5}
                                className="h-32 text-center text-text-muted"
                              >
                                {t('agent_usage.no_data')}
                              </TableCell>
                            </TableRow>
                          ) : (
                            result.rows.map((row, index) => (
                              <TableRow
                                key={`${row.author_name}-${row.agent_namespace}-${row.agent_name}-${index}`}
                              >
                                <TableCell className="text-left">{row.agent_name}</TableCell>
                                <TableCell className="text-left">{row.agent_namespace}</TableCell>
                                <TableCell className="text-left">{row.author_name}</TableCell>
                                <TableCell className="text-left tabular-nums">{row.pv}</TableCell>
                                <TableCell className="text-left tabular-nums">{row.uv}</TableCell>
                                {showAiMetrics && (
                                  <>
                                    <TableCell className="text-left tabular-nums">
                                      {row.ai_rounds}
                                    </TableCell>
                                    <TableCell className="text-left tabular-nums">
                                      {row.completed_ai_rounds}
                                    </TableCell>
                                  </>
                                )}
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                        {result.rows.length > 0 && (
                          <TableFooter>
                            <TableRow>
                              <TableCell className="font-semibold">
                                {t('agent_usage.total')}
                              </TableCell>
                              <TableCell colSpan={2} className="text-xs text-text-muted">
                                {t('agent_usage.uv_deduplicated')}
                              </TableCell>
                              <TableCell className="font-semibold tabular-nums">
                                {result.pv}
                              </TableCell>
                              <TableCell className="font-semibold tabular-nums">
                                {result.uv}
                              </TableCell>
                              {showAiMetrics && (
                                <>
                                  <TableCell className="font-semibold tabular-nums">
                                    {result.ai_rounds}
                                  </TableCell>
                                  <TableCell className="font-semibold tabular-nums">
                                    {result.completed_ai_rounds}
                                  </TableCell>
                                </>
                              )}
                            </TableRow>
                          </TableFooter>
                        )}
                      </Table>
                    </div>
                  </TabsContent>
                  <TabsContent value="daily" className="mt-0">
                    <p className="border-b border-border px-5 py-3 text-xs text-text-muted">
                      {t('agent_usage.daily_detail_count', {
                        count: result.daily_rows.length,
                      })}
                    </p>
                    <DailyUsageChart
                      rows={result.daily_rows}
                      showAiMetrics={showAiMetrics}
                      labels={{
                        usageTrend: t('agent_usage.usage_trend'),
                        aiTrend: t('agent_usage.ai_trend'),
                        pv: 'PV',
                        uv: 'UV',
                        aiRounds: t('agent_usage.ai_rounds'),
                        completedAiRounds: t('agent_usage.completed_ai_rounds'),
                        selectAgents: t('agent_usage.chart_select_agents'),
                        shownAgents: t('agent_usage.chart_shown_agents'),
                        topAgents: t('agent_usage.chart_top_agents'),
                        selectAll: t('agent_usage.chart_select_all'),
                        clearAll: t('agent_usage.chart_clear_all'),
                      }}
                    />
                    <div className="overflow-x-auto border-t border-border">
                      <Table className="text-left">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="px-4 text-left">
                              {t('agent_usage.agent')}
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              {t('agent_usage.date')}
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              <MetricLabel label="PV" tip={t('agent_usage.pv_tip')} />
                            </TableHead>
                            <TableHead className="px-4 text-left">
                              <MetricLabel label="UV" tip={t('agent_usage.daily_uv_tip')} />
                            </TableHead>
                            {showAiMetrics && (
                              <>
                                <TableHead className="px-4 text-left">
                                  {t('agent_usage.ai_rounds')}
                                </TableHead>
                                <TableHead className="px-4 text-left">
                                  {t('agent_usage.completed_ai_rounds')}
                                </TableHead>
                              </>
                            )}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.daily_rows.length === 0 ? (
                            <TableRow>
                              <TableCell
                                colSpan={showAiMetrics ? 6 : 4}
                                className="h-24 text-center text-text-muted"
                              >
                                {t('agent_usage.no_data')}
                              </TableCell>
                            </TableRow>
                          ) : (
                            result.daily_rows.map(row => (
                              <TableRow
                                key={`${row.agent_namespace}-${row.agent_name}-${row.date}`}
                              >
                                <TableCell className="text-left">{row.agent_name}</TableCell>
                                <TableCell className="text-left">{row.date}</TableCell>
                                <TableCell className="text-left tabular-nums">{row.pv}</TableCell>
                                <TableCell className="text-left tabular-nums">{row.uv}</TableCell>
                                {showAiMetrics && (
                                  <>
                                    <TableCell className="text-left tabular-nums">
                                      {row.ai_rounds}
                                    </TableCell>
                                    <TableCell className="text-left tabular-nums">
                                      {row.completed_ai_rounds}
                                    </TableCell>
                                  </>
                                )}
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </TabsContent>
                </Tabs>
              </Card>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
