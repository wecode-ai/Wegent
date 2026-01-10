'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Flow page component.
 */
import { useCallback, useState } from 'react'
import { Workflow, List, Clock } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FlowProvider, useFlowContext } from '../contexts/flowContext'
import { FlowList } from './FlowList'
import { FlowTimeline } from './FlowTimeline'
import { FlowForm } from './FlowForm'
import type { Flow } from '@/types/flow'

function FlowPageContent() {
  const { t } = useTranslation('flow')
  const { activeTab, setActiveTab, refreshFlows, refreshExecutions } = useFlowContext()

  // Form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null)

  const handleCreateFlow = useCallback(() => {
    setEditingFlow(null)
    setFormOpen(true)
  }, [])

  const handleEditFlow = useCallback((flow: Flow) => {
    setEditingFlow(flow)
    setFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshFlows()
    refreshExecutions()
  }, [refreshFlows, refreshExecutions])

  return (
    <div className="flex h-full flex-col bg-base">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Workflow className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-text-muted">{t('subtitle')}</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={value => setActiveTab(value as 'timeline' | 'config')}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="border-b border-border px-6">
          <TabsList className="h-12 bg-transparent p-0">
            <TabsTrigger
              value="timeline"
              className="relative h-12 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <Clock className="mr-2 h-4 w-4" />
              {t('tab_timeline')}
            </TabsTrigger>
            <TabsTrigger
              value="config"
              className="relative h-12 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <List className="mr-2 h-4 w-4" />
              {t('tab_config')}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 overflow-hidden">
          <TabsContent value="timeline" className="h-full m-0 p-0">
            <FlowTimeline />
          </TabsContent>
          <TabsContent value="config" className="h-full m-0 p-0">
            <FlowList onCreateFlow={handleCreateFlow} onEditFlow={handleEditFlow} />
          </TabsContent>
        </div>
      </Tabs>

      {/* Form */}
      <FlowForm
        open={formOpen}
        onOpenChange={setFormOpen}
        flow={editingFlow}
        onSuccess={handleFormSuccess}
      />
    </div>
  )
}

export function FlowPage() {
  return (
    <FlowProvider>
      <FlowPageContent />
    </FlowProvider>
  )
}
