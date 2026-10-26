export interface StartupProgressStageCopy {
  en: string
  zh: string
}

export interface StartupProgressStage {
  id: string
  label: StartupProgressStageCopy
  detail: StartupProgressStageCopy
  /** Share of the overall progress bar owned by this stage. */
  weight: number
  /** Expected duration used to pace the progress bar while the stage runs. */
  expectedMs: number
  /** Time allowed in this stage before the splash reports a timeout. */
  timeoutMs: number
}

export type StartupActivityKind = 'scan' | 'unpack' | 'migrate' | 'load'

export interface StartupProgressActivity {
  kind: StartupActivityKind
  path: string
}

export interface StartupProgressUpdate {
  index: number
  total: number
  completedWeight: number
  stage: StartupProgressStage
  startedAt: number
  activity?: StartupProgressActivity
}

export const STARTUP_PROGRESS_CHANNEL = 'startup-progress:update'
export const STARTUP_ACTIVITY_MIN_INTERVAL_MS = 80

const DEFAULT_STAGE_TIMEOUT_MS = 60_000

/**
 * Mirrors the real Electron startup sequence. Labels stay user-facing: every
 * stage describes the work happening right now instead of a generic animation.
 */
export const STARTUP_PROGRESS_STAGES: readonly StartupProgressStage[] = [
  {
    id: 'launch',
    label: { en: 'Starting Wework', zh: '启动应用' },
    detail: {
      en: 'Preparing the local environment…',
      zh: '正在准备本地环境…',
    },
    weight: 5,
    expectedMs: 800,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
  {
    id: 'shell',
    label: { en: 'Loading the workbench', zh: '加载工作台' },
    detail: {
      en: 'Loading the workbench window…',
      zh: '正在加载工作台界面…',
    },
    weight: 5,
    expectedMs: 900,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
  {
    id: 'components',
    label: { en: 'Checking local components', zh: '检查本地组件' },
    detail: {
      en: 'Scanning local component files…',
      zh: '正在扫描本地组件文件…',
    },
    weight: 15,
    expectedMs: 2_500,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
  {
    id: 'runtime-files',
    label: { en: 'Preparing the runtime', zh: '准备运行环境' },
    detail: {
      en: 'Verifying and unpacking runtime files…',
      zh: '正在校验并解压运行环境…',
    },
    weight: 15,
    expectedMs: 4_000,
    timeoutMs: 120_000,
  },
  {
    id: 'cli',
    label: { en: 'Installing local commands', zh: '安装本地命令' },
    detail: {
      en: 'Writing the wework command…',
      zh: '正在写入 wework 命令…',
    },
    weight: 5,
    expectedMs: 1_200,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
  {
    id: 'workspace',
    label: { en: 'Preparing your workspace', zh: '准备工作区' },
    detail: {
      en: 'Scanning and migrating workspace data…',
      zh: '正在扫描并迁移工作区数据…',
    },
    weight: 15,
    expectedMs: 3_500,
    timeoutMs: 120_000,
  },
  {
    id: 'services',
    label: { en: 'Connecting local services', zh: '连接本地服务' },
    detail: {
      en: 'Starting local service bridges…',
      zh: '正在启动本地服务连接…',
    },
    weight: 8,
    expectedMs: 1_500,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
  {
    id: 'core-dsh',
    label: { en: 'Starting the local service', zh: '启动本地服务' },
    detail: {
      en: 'Starting the Core service process…',
      zh: '正在启动 Core 服务进程…',
    },
    weight: 22,
    expectedMs: 6_000,
    // Matches the Core DSH startup budget in desktop-runtime.ts.
    timeoutMs: 120_000,
  },
  {
    id: 'renderer',
    label: { en: 'Loading tasks and projects', zh: '加载任务与项目' },
    detail: {
      en: 'Loading your tasks, projects, and workspace…',
      zh: '正在加载任务、项目和工作区…',
    },
    weight: 10,
    expectedMs: 4_500,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
]

export function startupProgressTotalWeight(): number {
  return STARTUP_PROGRESS_STAGES.reduce((total, stage) => total + stage.weight, 0)
}

export class StartupProgressReporter {
  private index = -1
  private current: StartupProgressUpdate | null = null
  private lastActivityPublishedAt = 0

  constructor(
    private readonly publish: (update: StartupProgressUpdate) => void,
    private readonly now: () => number = Date.now
  ) {}

  report(stageId: string): void {
    const index = STARTUP_PROGRESS_STAGES.findIndex(stage => stage.id === stageId)
    if (index < 0) throw new Error(`Unknown startup progress stage: ${stageId}`)
    if (index <= this.index) return
    this.index = index
    this.lastActivityPublishedAt = 0
    this.current = {
      index,
      total: STARTUP_PROGRESS_STAGES.length,
      completedWeight: STARTUP_PROGRESS_STAGES.slice(0, index).reduce(
        (total, stage) => total + stage.weight,
        0
      ),
      stage: STARTUP_PROGRESS_STAGES[index],
      startedAt: this.now(),
    }
    this.publish(this.current)
  }

  /**
   * Reports the concrete file being scanned or unpacked. Updates are throttled
   * so the splash flickers with real work without flooding the renderer.
   */
  reportActivity(kind: StartupActivityKind, path: string): void {
    if (!this.current || !path.trim()) return
    const now = this.now()
    if (now - this.lastActivityPublishedAt < STARTUP_ACTIVITY_MIN_INTERVAL_MS) return
    this.lastActivityPublishedAt = now
    this.current = { ...this.current, activity: { kind, path } }
    this.publish(this.current)
  }
}
