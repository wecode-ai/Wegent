import { Check, Circle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimePlanEventPayload, RuntimePlanStep } from '@/types/api'

const COMPLETED_PLAN_NOTICE_DURATION_MS = 2200

export function TaskPlanProgress({ plan }: { plan?: RuntimePlanEventPayload | null }) {
  if (!plan?.plan.length) return null

  const allCompleted = plan.plan.every(step => step.status === 'completed')
  if (allCompleted) {
    return <CompletedTaskPlanProgress key={runtimePlanIdentity(plan)} plan={plan} />
  }
  return <TaskPlanProgressContent plan={plan} allCompleted={false} />
}

function CompletedTaskPlanProgress({ plan }: { plan: RuntimePlanEventPayload }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), COMPLETED_PLAN_NOTICE_DURATION_MS)
    return () => window.clearTimeout(timeout)
  }, [])

  return visible ? <TaskPlanProgressContent plan={plan} allCompleted /> : null
}

function TaskPlanProgressContent({
  plan,
  allCompleted,
}: {
  plan: RuntimePlanEventPayload
  allCompleted: boolean
}) {
  const { t } = useTranslation('common')
  const currentIndex = currentPlanStepIndex(plan.plan)
  const activeStep = plan.plan[currentIndex]

  return (
    <div data-testid="runtime-plan-progress" className="relative z-0 mb-2 flex justify-center">
      <div className="group relative" tabIndex={0}>
        <div
          className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 w-max max-w-[min(31rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-border/70 bg-background px-3.5 py-2.5 opacity-0 shadow-[0_8px_22px_rgba(0,0,0,0.08)] transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
          data-testid="runtime-plan-popover"
        >
          <ol className="space-y-1">
            {plan.plan.map((step, index) => (
              <li
                key={`${index}-${step.step}`}
                className="flex items-start gap-1.5 text-xs leading-[18px] text-text-secondary"
              >
                <PlanStepIcon step={step} compact />
                <span className={step.status === 'inProgress' ? 'text-text-primary' : ''}>
                  {step.step}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div
          aria-label={
            allCompleted
              ? t('workbench.task_plan_completed')
              : t('workbench.task_plan_progress', {
                  current: currentIndex + 1,
                  total: plan.plan.length,
                })
          }
          data-testid="runtime-plan-progress-button"
          className="flex h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-background px-3 text-xs font-normal text-text-secondary shadow-sm transition-colors group-hover:bg-surface group-focus:bg-surface"
        >
          <PlanStepIcon step={activeStep} />
          <span>
            {allCompleted
              ? t('workbench.task_plan_completed')
              : t('workbench.task_plan_progress', {
                  current: currentIndex + 1,
                  total: plan.plan.length,
                })}
          </span>
        </div>
      </div>
    </div>
  )
}

function runtimePlanIdentity(plan: RuntimePlanEventPayload): string {
  return JSON.stringify({
    taskId: plan.taskId ?? null,
    subtaskId: plan.subtaskId ?? null,
    threadId: plan.threadId ?? null,
    turnId: plan.turnId ?? null,
    plan: plan.plan,
  })
}

function currentPlanStepIndex(plan: RuntimePlanStep[]): number {
  const inProgressIndex = plan.findIndex(step => step.status === 'inProgress')
  if (inProgressIndex >= 0) return inProgressIndex
  const pendingIndex = plan.findIndex(step => step.status === 'pending')
  return pendingIndex >= 0 ? pendingIndex : Math.max(plan.length - 1, 0)
}

function PlanStepIcon({ step, compact = false }: { step: RuntimePlanStep; compact?: boolean }) {
  const sizeClass = compact ? 'h-3.5 w-3.5' : 'h-4 w-4'
  if (step.status === 'completed') {
    return <Check className={`mt-0.5 ${sizeClass} shrink-0 text-primary`} strokeWidth={2.5} />
  }
  return (
    <Circle
      className={`mt-0.5 ${sizeClass} shrink-0 ${step.status === 'inProgress' ? 'animate-pulse text-primary' : 'text-text-muted'}`}
      strokeWidth={2}
    />
  )
}
