import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import styles from './WorktreeCreationStatus.module.css'

interface WorktreeCreationStatusProps {
  className?: string
}

export function WorktreeCreationStatus({ className }: WorktreeCreationStatusProps) {
  const { t } = useTranslation('common')
  const [phaseIndex, setPhaseIndex] = useState(0)
  const phases = [
    t('workbench.worktree_creation_phase_locating', '定位当前提交…'),
    t('workbench.worktree_creation_phase_branching', '把新分支拎出来…'),
    t('workbench.worktree_creation_phase_expanding', '展开独立工作区…'),
    t('workbench.worktree_creation_phase_finishing', '最后整理一下文件…'),
  ]

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const interval = window.setInterval(() => {
      setPhaseIndex(current => (current + 1) % phases.length)
    }, 1200)

    return () => window.clearInterval(interval)
  }, [phases.length])

  return (
    <section
      data-testid="worktree-creation-status"
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-0 min-w-0 flex-1 items-center justify-center px-4 py-8 sm:px-6 sm:py-12',
        className
      )}
    >
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <div
          data-testid="worktree-creation-animation"
          className={styles.machine}
          aria-hidden="true"
        >
          <svg className={styles.blueprint} viewBox="0 0 540 254" preserveAspectRatio="none">
            <path className={styles.mainRail} d="M38 164 H292" />
            <path className={styles.branchRail} d="M196 164 C238 164 236 105 285 105 H455" />
            <g className={cn(styles.commit, styles.commitOne)}>
              <circle cx="88" cy="164" r="8" />
            </g>
            <g className={cn(styles.commit, styles.commitTwo)}>
              <circle cx="148" cy="164" r="8" />
            </g>
            <g className={styles.commit}>
              <circle cx="196" cy="164" r="8" />
            </g>
            <g className={cn(styles.commit, styles.newCommit)}>
              <circle cx="286" cy="105" r="12" />
              <path d="M280 105h12M286 99v12" />
            </g>
          </svg>

          <div className={styles.crane}>
            <div className={styles.craneHead} />
            <div className={styles.craneCable} />
            <div className={styles.craneHook} />
          </div>

          <div className={styles.workspace}>
            <div className={styles.workspaceTop}>
              <span />
              <span />
              <span />
            </div>
            <div className={styles.workspaceBody}>
              <div className={styles.workspaceTree}>
                <span />
                <span />
                <span />
              </div>
              <div className={styles.code}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>

          <span className={cn(styles.spark, styles.sparkOne)} />
          <span className={cn(styles.spark, styles.sparkTwo)} />
          <span className={cn(styles.spark, styles.sparkThree)} />
        </div>

        <h1 className="heading-sm text-text-primary">
          {t('workbench.worktree_creation_title', '正在搭建你的独立工作树')}
        </h1>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.worktree_creation_description',
            '从当前分支搬一份代码出来。互不打扰，放心开工。'
          )}
        </p>
        <div className={styles.phase} aria-hidden="true">
          <span className={styles.phaseDot} />
          <span className={styles.phaseLabel}>{phases[phaseIndex]}</span>
        </div>
      </div>
    </section>
  )
}
