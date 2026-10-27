import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_GROUPS,
  expandDesktopCheckpoints,
} from './checkpoints.mjs'
import { runWithCheckpointResources } from './checkpoint-scheduler.mjs'
import { resolveDesktopCodexBinary } from './modules/desktop-build-flows.mjs'
import { resolveDesktopPackageLayout } from './modules/desktop-package-layout.mjs'
import {
  compactInactiveDesktopE2EResults,
  resolveDesktopE2EResultRoot,
} from './result-retention.mjs'
import { prepareDesktopE2EBuild } from '../../scripts/lib/desktop-e2e-build.mjs'
import { runCommandToLog } from '../../scripts/lib/command-log.mjs'

const HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_PARALLEL_CHECKPOINTS = 1
const CHECKPOINT_RESOURCES = new Map([
  // These macOS checkpoints move native windows and require a foreground renderer for cursor arrival.
  ['browser-toolbar-actions', ['macos-inspector-foreground']],
  ['tray-lifecycle', ['macos-inspector-foreground']],
  ['browser-annotation-design', ['macos-inspector-foreground']],
  ['project-assignment-notification', ['macos-inspector-foreground']],
])
const CHECKPOINT_SCENARIO_MODULES = {
  'notification-tab-navigation': './scenarios/notification-tab-navigation.scenario.mjs',
  'voice-input': './scenarios/voice-input.scenario.mjs',
  'renderer-crash-recovery': './scenarios/renderer-crash-recovery.scenario.mjs',
  'archived-worktree-cleanup': './scenarios/archived-worktree-cleanup.scenario.mjs',
  'plugin-toggle-persistence': './scenarios/plugin-toggle-persistence.scenario.mjs',
  'goal-state-sync': './scenarios/goal-stopped-state.scenario.mjs',
  'collaboration-worktree-policy': './scenarios/collaboration-worktree-policy.scenario.mjs',
  'cloud-model-recovery': './scenarios/cloud-model-recovery.scenario.mjs',
  'task-model-deletion': './scenarios/task-model-deletion.scenario.mjs',
  'cloud-model-presets': './scenarios/cloud-model-presets.scenario.mjs',
  'plugin-account-auth-password': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-account-auth-transfer': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-account-auth-oauth': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-account-auth-dws': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-account-auth-conversation': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-account-auth-github': './scenarios/plugin-account-auth.scenario.mjs',

  'plugin-registration-coordination': './scenarios/plugin-uninstall-resilience.scenario.mjs',
  'plugin-account-auth-coordination': './scenarios/plugin-account-auth.scenario.mjs',
  'plugin-write-coordination': './scenarios/plugin-uninstall-resilience.scenario.mjs',
  'plugin-uninstall-lost-response': './scenarios/plugin-uninstall-resilience.scenario.mjs',
  'plugin-uninstall-unknown-result': './scenarios/plugin-uninstall-resilience.scenario.mjs',
  'plugin-uninstall-restart-recovery': './scenarios/plugin-uninstall-resilience.scenario.mjs',
  'plugin-uninstall-reinstall-race': './scenarios/plugin-uninstall-resilience.scenario.mjs',

  'plugin-composer-long-list': './scenarios/plugin-composer-long-list.scenario.mjs',
  'plugin-collaboration-composer-isolation':
    './scenarios/plugin-collaboration-composer-isolation.scenario.mjs',
  'plugin-runtime-path-recovery': './scenarios/plugin-runtime-path-recovery.scenario.mjs',
  'codex-account-login': './scenarios/codex-account-login.scenario.mjs',
  'runtime-input-answer-persistence': './scenarios/runtime-input-answer-persistence.scenario.mjs',
  'cloud-space-mention': './scenarios/cloud-space-mention.scenario.mjs',
  'conversation-state': './scenarios/conversation-mention.scenario.mjs',
  'temporary-chat': './scenarios/temporary-chat.scenario.mjs',
  'embedded-browser': './scenarios/embedded-browser-agent.scenario.mjs',
  'collaboration-issue-badges': './scenarios/collaboration-issue-badges.scenario.mjs',
  'change-request-status': './scenarios/change-request-status.scenario.mjs',
  'git-commit-generation': './scenarios/git-commit-generation.scenario.mjs',
  'claude-runtime': './scenarios/claude-runtime.scenario.mjs',
  'local-file-preview': './scenarios/local-file-preview.scenario.mjs',
  'office-file-preview': './scenarios/office-file-preview.scenario.mjs',
  'local-harness': './scenarios/local-terminal.scenario.mjs',
  'harness-app-development': './scenarios/harness-apps.scenario.mjs',
  'harness-app-lifecycle': './scenarios/harness-apps.scenario.mjs',

  'browser-multi-tabs': './scenarios/embedded-browser-multi-tabs.scenario.mjs',
  'browser-toolbar-actions': './scenarios/embedded-browser-toolbar-actions.scenario.mjs',
  'browser-annotation-core': './scenarios/embedded-browser-annotation.scenario.mjs',
  'browser-annotation-anchors': './scenarios/embedded-browser-annotation.scenario.mjs',
  'browser-annotation-design': './scenarios/embedded-browser-annotation.scenario.mjs',
  'streaming-content': './scenarios/streaming-text.scenario.mjs',
  'streaming-tools': './scenarios/streaming-text.scenario.mjs',
  'streaming-timers': './scenarios/streaming-text.scenario.mjs',
  'streaming-scroll': './scenarios/streaming-text.scenario.mjs',
  'streaming-message-order': './scenarios/streaming-text.scenario.mjs',
  'streaming-conversation-switching': './scenarios/streaming-text.scenario.mjs',
  'streaming-subagents': './scenarios/streaming-text.scenario.mjs',

  'runtime-task-queue': './scenarios/runtime-task-queue.scenario.mjs',
  'codex-invalid-launch-cwd': './scenarios/codex-invalid-launch-cwd.scenario.mjs',
  'executor-stream-recovery': './scenarios/executor-stream-recovery.scenario.mjs',
  'model-overload-recovery': './scenarios/goal-overload-recovery.scenario.mjs',
  'transcript-sync': './scenarios/transcript-sync.scenario.mjs',
  'running-conversation-history': './scenarios/running-conversation-history.scenario.mjs',
  'latest-conversation-history': './scenarios/latest-conversation-history.scenario.mjs',
  'running-plan-history': './scenarios/running-plan-history.scenario.mjs',
  'running-sidebar-state': './scenarios/running-sidebar-state.scenario.mjs',
  'codex-notification-isolation': './scenarios/codex-notification-isolation.scenario.mjs',
  'context-compaction': './scenarios/context-compaction.scenario.mjs',
  'background-terminals': './scenarios/background-terminals.scenario.mjs',
  'computer-use': './scenarios/computer-use.scenario.mjs',
  'split-workbench': './scenarios/split-workbench.scenario.mjs',
  'release-package-startup': './scenarios/release-package-startup.scenario.mjs',
  'app-update-full': './scenarios/app-update-full.scenario.mjs',
  'component-update': './scenarios/component-update.scenario.mjs',
  'windows-update-install': './scenarios/windows-update.scenario.mjs',
  'windows-update-validation': './scenarios/windows-update.scenario.mjs',
  'windows-update-rollback': './scenarios/windows-update.scenario.mjs',
  'windows-update-recovery': './scenarios/windows-update.scenario.mjs',
  'windows-update-migration': './scenarios/windows-update-migration.scenario.mjs',
  'windows-update-reinstall': './scenarios/windows-update-reinstall.scenario.mjs',
  'native-window-startup': './scenarios/native-window-startup.scenario.mjs',
  'native-window-chrome': './scenarios/native-window-chrome.scenario.mjs',
  'renderer-storage': './scenarios/renderer-storage.scenario.mjs',
  'application-menu': './scenarios/application-menu.scenario.mjs',
  'tray-lifecycle': './scenarios/tray-lifecycle.scenario.mjs',
  'project-automation': './scenarios/project-automation.scenario.mjs',
  'project-assignment-notification': './scenarios/project-assignment-notification.scenario.mjs',
  'project-member-overrides': './scenarios/project-member-overrides.scenario.mjs',
  'offline-local-project-space': './scenarios/offline-local-project-space.scenario.mjs',
  'cloud-context-resilience': './scenarios/cloud-context-resilience.scenario.mjs',
  'cloud-login-proxy': './scenarios/cloud-login-proxy.scenario.mjs',
  'collaboration-deliveries': './scenarios/collaboration-deliveries.scenario.mjs',
  'collaboration-shared-core': './scenarios/collaboration-shared-core.scenario.mjs',
  'collaboration-issue-task-discovery':
    './scenarios/collaboration-issue-task-discovery.scenario.mjs',
  'collaboration-app-queue-identity': './scenarios/collaboration-app-queue-identity.scenario.mjs',
  'collaboration-runtime-reconciliation':
    './scenarios/collaboration-runtime-reconciliation.scenario.mjs',
  'collaboration-first-use': './scenarios/collaboration-first-use.scenario.mjs',
  'collaboration-group-onboarding': './scenarios/collaboration-group-onboarding.scenario.mjs',
  'collaboration-local-agent-dispatch':
    './scenarios/collaboration-local-agent-dispatch.scenario.mjs',
  'stand-in-action-confirmation': './scenarios/stand-in-action-confirmation.scenario.mjs',
  'stand-in-list-confirmation': './scenarios/stand-in-list-confirmation.scenario.mjs',
  'stand-in-profile-settings': './scenarios/stand-in-profile.scenario.mjs',
  'stand-in-model-catalog': './scenarios/stand-in-model-catalog.scenario.mjs',
  'stand-in-identities': './scenarios/stand-in-identities.scenario.mjs',
  'stand-in-connections': './scenarios/stand-in-connections.scenario.mjs',
  'stand-in-mcp': './scenarios/stand-in-mcp.scenario.mjs',
  'stand-in-cli': './scenarios/stand-in-cli.scenario.mjs',
  'stand-in-plugin-bridge': './scenarios/stand-in-plugin-bridge.scenario.mjs',
  'stand-in-assignment-notifications': './scenarios/stand-in-assignment-notifications.scenario.mjs',
  'stand-in-personal-task': './scenarios/stand-in-personal-task.scenario.mjs',
  'stand-in': './scenarios/stand-in.scenario.mjs',
  'stand-in-cloud': './scenarios/stand-in-cloud.scenario.mjs',
  'stand-in-permissions': './scenarios/stand-in-permissions.scenario.mjs',
  'stand-in-workspace': './scenarios/stand-in-workspace.scenario.mjs',
  'stand-in-controls': './scenarios/stand-in-controls.scenario.mjs',
  'stand-in-project-enable': './scenarios/stand-in-project-enable.scenario.mjs',
  'stand-in-notifications': './scenarios/stand-in-notifications.scenario.mjs',
  'collaboration-remote-agent-dispatch':
    './scenarios/collaboration-remote-agent-dispatch.scenario.mjs',
  'collaboration-local-group-coordinate':
    './scenarios/collaboration-local-group-coordinate.scenario.mjs',
  'collaboration-remote-group-coordinate':
    './scenarios/collaboration-remote-group-coordinate.scenario.mjs',
  'collaboration-remote-group-planning-details':
    './scenarios/collaboration-remote-group-planning-details.scenario.mjs',
  'collaboration-human-round-resume': './scenarios/collaboration-human-round-resume.scenario.mjs',
  'collaboration-local-group-cancellation':
    './scenarios/collaboration-local-group-cancellation.scenario.mjs',
  'collaboration-issue-comment-mention':
    './scenarios/collaboration-issue-comment-mention.scenario.mjs',
  'collaboration-issue-assignment-activity':
    './scenarios/collaboration-issue-assignment-activity.scenario.mjs',
  'collaboration-issue-comment-attachments':
    './scenarios/collaboration-issue-comment-attachments.scenario.mjs',
  'collaboration-issue-comment-notification':
    './scenarios/collaboration-issue-comment-notification.scenario.mjs',
  'collaboration-issue-mcp-comments': './scenarios/collaboration-issue-mcp-comments.scenario.mjs',
  'collaboration-issue-attachment-preview':
    './scenarios/collaboration-issue-attachment-preview.scenario.mjs',
  'collaboration-issue-archive': './scenarios/collaboration-issue-archive.scenario.mjs',
  'collaboration-board-sorting': './scenarios/collaboration-board-sorting.scenario.mjs',
  'collaboration-board-move-recovery': './scenarios/collaboration-board-move-recovery.scenario.mjs',
  'plugin-development': './scenarios/plugin-development.scenario.mjs',
  'task-attachments': './scenarios/task-attachments.scenario.mjs',
  'drawing-attachment': './scenarios/drawing-attachment.scenario.mjs',
  'external-content-import': './scenarios/external-content-import.scenario.mjs',
  'send-key-preference': './scenarios/send-key-preference.scenario.mjs',
  'reply-predictions': './scenarios/reply-predictions.scenario.mjs',
  'reply-prediction-auth': './scenarios/reply-prediction-auth.scenario.mjs',
  'model-settings': './scenarios/model-settings.scenario.mjs',
  'codex-native-catalog': './scenarios/codex-native-catalog.scenario.mjs',
  'system-proxy': './scenarios/system-proxy.scenario.mjs',
  'system-pac': './scenarios/system-pac.scenario.mjs',
  'workbench-mode': './scenarios/workbench-mode.scenario.mjs',
  'task-board-bulk-actions': './scenarios/task-board-bulk-actions.scenario.mjs',
  'dsh-owner-capture': './scenarios/dsh-owner-capture.scenario.mjs',
}
const SCENARIO_ONLY_CHECKPOINTS = new Set([
  'notification-tab-navigation',
  'voice-input',
  'archived-worktree-cleanup',
  'plugin-toggle-persistence',
  'streaming-content',
  'streaming-tools',
  'streaming-timers',
  'streaming-scroll',
  'streaming-message-order',
  'streaming-conversation-switching',
  'streaming-subagents',

  'goal-state-sync',
  'model-settings',
  'codex-native-catalog',
  'runtime-input-answer-persistence',
  'reply-predictions',
  'reply-prediction-auth',
  'collaboration-worktree-policy',
  'cloud-model-recovery',
  'task-model-deletion',
  'cloud-model-presets',
  'plugin-account-auth-password',
  'plugin-account-auth-transfer',
  'plugin-account-auth-oauth',
  'plugin-account-auth-dws',
  'plugin-account-auth-conversation',
  'plugin-account-auth-github',
  'plugin-account-auth-coordination',

  'plugin-write-coordination',
  'plugin-registration-coordination',
  'plugin-uninstall-lost-response',
  'plugin-uninstall-unknown-result',
  'plugin-uninstall-restart-recovery',
  'plugin-uninstall-reinstall-race',

  'plugin-composer-long-list',
  'plugin-collaboration-composer-isolation',
  'plugin-runtime-path-recovery',
  'codex-account-login',
  'cloud-space-mention',
  'collaboration-issue-badges',
  'change-request-status',
  'git-commit-generation',
  'claude-runtime',
  'local-file-preview',
  'office-file-preview',
  'local-harness',
  'harness-app-development',
  'harness-app-lifecycle',

  'offline-local-project-space',
  'cloud-context-resilience',
  'cloud-login-proxy',
  'collaboration-shared-core',
  'collaboration-deliveries',
  'collaboration-issue-task-discovery',
  'collaboration-app-queue-identity',
  'collaboration-runtime-reconciliation',
  'collaboration-first-use',
  'collaboration-group-onboarding',
  'collaboration-local-agent-dispatch',
  'stand-in-action-confirmation',
  'stand-in-list-confirmation',
  'stand-in-profile-settings',
  'stand-in-model-catalog',
  'stand-in-identities',
  'stand-in-connections',
  'stand-in-mcp',
  'stand-in-cli',
  'stand-in-plugin-bridge',
  'stand-in-assignment-notifications',
  'stand-in-personal-task',
  'stand-in',
  'stand-in-cloud',
  'stand-in-permissions',
  'stand-in-workspace',
  'stand-in-controls',
  'stand-in-project-enable',
  'stand-in-notifications',
  'collaboration-remote-agent-dispatch',
  'collaboration-local-group-coordinate',
  'collaboration-remote-group-coordinate',
  'collaboration-remote-group-planning-details',
  'collaboration-human-round-resume',
  'collaboration-local-group-cancellation',
  'collaboration-issue-comment-mention',
  'collaboration-issue-assignment-activity',
  'collaboration-issue-comment-attachments',
  'collaboration-issue-comment-notification',
  'collaboration-issue-mcp-comments',
  'collaboration-issue-attachment-preview',
  'collaboration-issue-archive',
  'collaboration-board-sorting',
  'collaboration-board-move-recovery',
  'plugin-development',
  'task-attachments',
  'drawing-attachment',
  'project-assignment-notification',
  'project-member-overrides',
  'runtime-task-queue',
  'codex-invalid-launch-cwd',
  'executor-stream-recovery',
  'model-overload-recovery',
  'transcript-sync',
  'running-conversation-history',
  'latest-conversation-history',
  'running-plan-history',
  'running-sidebar-state',
  'codex-notification-isolation',
  'context-compaction',
  'background-terminals',
  'computer-use',
  'split-workbench',
  'release-package-startup',
  'app-update-full',
  'component-update',
  'windows-update-install',
  'windows-update-validation',
  'windows-update-rollback',
  'windows-update-recovery',
  'windows-update-migration',
  'windows-update-reinstall',
  'renderer-crash-recovery',
  'native-window-startup',
  'native-window-chrome',
  'renderer-storage',
  'application-menu',
  'tray-lifecycle',
  'temporary-chat',
  'browser-annotation-core',
  'browser-annotation-anchors',
  'browser-annotation-design',
  'external-content-import',
  'send-key-preference',
  'system-proxy',
  'system-pac',
  'workbench-mode',
  'task-board-bulk-actions',
])
const CLOUD_ONLY_CHECKPOINTS = new Set([
  'cloud-device-lifecycle',
  'plugin-auto-update',
  'plugin-workspace-publication',
  'cloud-git-worktree',
  'cloud-worktree-capability',
  'cloud-worktree-create',
  'cloud-worktree-queued-cancel',
  'cloud-worktree-tools',
  'cloud-worktree-archive-restore',
])
const COMPOSITE_CHECKPOINTS = DESKTOP_CHECKPOINT_GROUPS
// These checkpoints materialize packaged runtimes or repeatedly reload the full
// renderer. Run them alone so Chromium's network service stays stable on the
// four-vCPU desktop E2E runners.
const RESOURCE_EXCLUSIVE_CHECKPOINTS = new Set([
  'release-package-startup',
  'collaboration-issue-task-discovery',
])
const DEFAULT_DESKTOP_CHECKPOINTS = DESKTOP_CHECKPOINTS.filter(
  checkpoint => !COMPOSITE_CHECKPOINTS.has(checkpoint)
)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const taskFlowPath = join(scriptDir, 'task-flow.e2e.mjs')
const isolatedXvfbPath = join(scriptDir, 'run-with-openbox.sh')
const cliArgs = process.argv.slice(2)
const requestedArgs = cliArgs[0] === '--' ? cliArgs.slice(1) : cliArgs

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function runTaskFlow(args, env, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let resultDir = null
    let outputTail = ''
    let stderrTail = ''
    const isolateDisplay = process.platform === 'linux' && env.WEWORK_E2E_ISOLATED_XVFB === 'true'
    const command = isolateDisplay ? 'xvfb-run' : process.execPath
    const commandArgs = isolateDisplay
      ? [
          '-a',
          '--server-args=-screen 0 1280x720x24',
          'sh',
          isolatedXvfbPath,
          process.execPath,
          taskFlowPath,
          ...args,
        ]
      : [taskFlowPath, ...args]
    const child = spawn(command, commandArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const forward = (chunk, destination, captureStderr = false) => {
      lastOutputAt = Date.now()
      const text = chunk.toString()
      destination.write(text)
      outputTail = `${outputTail}${text}`.slice(-12_000)
      const resultDirMatch = outputTail.match(/\[desktop-e2e] result directory: ([^\r\n]+)/)
      if (resultDirMatch) resultDir = resultDirMatch[1].trim()
      if (captureStderr) stderrTail = `${stderrTail}${text}`.slice(-12_000)
    }
    child.stdout.on('data', chunk => forward(chunk, process.stdout))
    child.stderr.on('data', chunk => forward(chunk, process.stderr, true))

    const heartbeat = setInterval(() => {
      const now = Date.now()
      console.log(
        `[desktop-e2e] ${label} still running: elapsed=${formatDuration(now - startedAt)}, last-output=${formatDuration(now - lastOutputAt)} ago`
      )
    }, HEARTBEAT_INTERVAL_MS)

    child.once('error', error => {
      clearInterval(heartbeat)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearInterval(heartbeat)
      resolvePromise({
        code: code ?? 1,
        durationMs: Date.now() - startedAt,
        resultDir,
        signal,
        stderrTail,
      })
    })
  })
}

async function readFailureSummary(result) {
  if (result.resultDir) {
    try {
      const failure = await readFile(join(result.resultDir, 'failure.txt'), 'utf8')
      const firstLine = failure.split(/\r?\n/, 1)[0]?.trim()
      if (firstLine) return firstLine
    } catch {
      // Fall back to captured stderr when failure evidence was not written.
    }
  }
  return (
    result.stderrTail
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'No failure details were emitted'
  )
}

function checkpointScenarioEnv(env, checkpoint) {
  const nextEnv = { ...env }
  if (checkpoint === 'collaboration-shared-core') {
    // Exercise timezone-less UTC API timestamps outside the UTC timezone.
    nextEnv.TZ = 'Asia/Shanghai'
  }
  if (
    checkpoint === 'application-menu' ||
    checkpoint === 'native-window-chrome' ||
    checkpoint === 'browser-multi-tabs' ||
    checkpoint === 'core-task-flow' ||
    checkpoint === 'project-assignment-notification'
  ) {
    // These checks present native auxiliary windows and must observe them as
    // visible. macOS background mode prohibits activation and hides the app.
    // Assignment notification also verifies tag commits through native focus loss.
    nextEnv.WEWORK_E2E_BACKGROUND_WINDOW = '0'
  }
  const module = CHECKPOINT_SCENARIO_MODULES[checkpoint]
  if (module) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE = module
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE
  }
  if (SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY = 'true'
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY
  }
  return nextEnv
}

async function runDesktopBuild() {
  const startedAt = Date.now()
  const logPath = join(weworkDir, 'test-results', 'desktop-e2e', `desktop-build-${process.pid}.log`)
  console.log(
    `[desktop-e2e] Building the shared Electron application and executor. Full log: ${logPath}`
  )
  const heartbeat = setInterval(() => {
    console.log(
      `[desktop-e2e] Desktop build still running: elapsed=${formatDuration(Date.now() - startedAt)}`
    )
  }, HEARTBEAT_INTERVAL_MS)

  let result
  try {
    result = await runCommandToLog({
      args: ['run', 'ai:verify:electron:build'],
      command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      cwd: weworkDir,
      env: process.env,
      logPath,
    })
  } finally {
    clearInterval(heartbeat)
  }

  if (result.code !== 0) {
    console.error(
      `[desktop-e2e] Desktop build failed: ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}. Full log: ${logPath}`
    )
    if (result.tail.trim()) {
      console.error(`[desktop-e2e] Desktop build output tail:\n${result.tail.trimEnd()}`)
    }
    throw new Error(`Desktop E2E build exited with code ${result.code}`)
  }
  console.log(
    `[desktop-e2e] Desktop build passed: duration=${formatDuration(Date.now() - startedAt)}. Full log: ${logPath}`
  )
}

async function sharedBuildEnvironment(environment = process.env) {
  const [build, codexBinary] = await Promise.all([
    prepareDesktopE2EBuild({
      environment,
      runBuild: runDesktopBuild,
      weworkDir,
    }),
    resolveDesktopCodexBinary(),
  ])
  console.log(
    `[desktop-e2e] shared build ready: app=${build.appBinary}, executor=${build.executorBinary}, codex=${codexBinary}`
  )
  return {
    ...environment,
    WEWORK_E2E_APP_BIN: build.appBinary,
    WEWORK_E2E_CODEX_BIN: codexBinary,
    WEWORK_E2E_EXECUTOR_BIN: build.executorBinary,
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', resolvePromise)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

async function extractArchive(archivePath, destination) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', destination], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          `Core DSH runtime extraction failed: ${signal ? `signal=${signal}` : `exit=${code}`}`
        )
      )
    })
  })
}

async function prepareSharedHarnessRuntime(appBinary, parentDirectory) {
  const { resourcesRoot } = await resolveDesktopPackageLayout(appBinary)
  const resourceRoot = join(resourcesRoot, 'harness-runtime')
  const catalog = JSON.parse(await readFile(join(resourceRoot, 'runtimes.json'), 'utf8'))
  const runtimes =
    catalog.runtimes?.filter(runtime => ['core', 'workbench'].includes(runtime.role)) ?? []
  const roles = new Set(runtimes.map(runtime => runtime.role))
  if (!roles.has('core') || !roles.has('workbench')) {
    throw new Error('Bundled Electron runtime catalog must contain Core and Workbench runtimes')
  }

  const runtimeRoot = join(parentDirectory, 'harness-runtime')
  const startedAt = Date.now()
  await mkdir(runtimeRoot, { recursive: true })
  for (const runtime of runtimes) {
    if (
      !/^[0-9a-f]{64}$/.test(runtime.sourceFingerprint) ||
      !/^[0-9a-f]{64}$/.test(runtime.archiveSha256) ||
      !Number.isSafeInteger(runtime.archiveBytes) ||
      runtime.archiveBytes <= 0 ||
      typeof runtime.assetName !== 'string' ||
      !runtime.assetName.endsWith('.tar.gz')
    ) {
      throw new Error('Bundled Electron runtime descriptor is invalid')
    }

    const archivePath = join(resourceRoot, runtime.assetName)
    const archiveMetadata = await stat(archivePath)
    if (archiveMetadata.size !== runtime.archiveBytes) {
      throw new Error(`Bundled DSH runtime size mismatch: ${runtime.assetName}`)
    }
    if ((await fileSha256(archivePath)) !== runtime.archiveSha256) {
      throw new Error(`Bundled DSH runtime checksum mismatch: ${runtime.assetName}`)
    }

    const extractedRoot = join(runtimeRoot, runtime.sourceFingerprint)
    await mkdir(extractedRoot, { recursive: true })
    await extractArchive(archivePath, extractedRoot)
    const identity = JSON.parse(await readFile(join(extractedRoot, 'runtime.json'), 'utf8'))
    if (
      identity.dshVersion !== runtime.dshVersion ||
      !(
        identity.role === runtime.role ||
        (Array.isArray(identity.roles) && identity.roles.includes(runtime.role))
      ) ||
      identity.sourceFingerprint !== runtime.sourceFingerprint
    ) {
      throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
    }
  }
  await writeFile(join(runtimeRoot, 'runtimes.json'), `${JSON.stringify({ runtimes }, null, 2)}\n`)
  console.log(
    `[desktop-e2e] shared harness runtimes ready: duration=${formatDuration(Date.now() - startedAt)}, root=${runtimeRoot}`
  )
  return runtimeRoot
}

function requestedCheckpointRange(args) {
  if (args.length !== 2) return null
  const [flag, checkpoint] = args
  if (flag === '--segment') return expandDesktopCheckpoints([checkpoint])
  if (flag === '--from-segment') {
    const startCheckpoint = COMPOSITE_CHECKPOINTS.get(checkpoint)?.[0] ?? checkpoint
    const startIndex = DEFAULT_DESKTOP_CHECKPOINTS.indexOf(startCheckpoint)
    if (startIndex < 0) return null
    return DEFAULT_DESKTOP_CHECKPOINTS.slice(startIndex)
  }
  return null
}

function requestedParallelCheckpoints(args) {
  if (args.length !== 2 || args[0] !== '--parallel-segments') return null
  const checkpoints = args[1]
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (checkpoints.length === 0) {
    throw new Error('--parallel-segments requires at least one checkpoint')
  }
  for (const checkpoint of checkpoints) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
  }
  return expandDesktopCheckpoints(checkpoints)
}

function parallelCheckpointLimit() {
  const value = Number(process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS ?? DEFAULT_PARALLEL_CHECKPOINTS)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('WEWORK_E2E_PARALLEL_CHECKPOINTS must be a positive integer')
  }
  return value
}

function parallelCheckpointArgs(checkpoint) {
  // Scenario modules declare their own cloud prerequisites. Cloud is a shard
  // scope here, not a second mutually exclusive task-flow execution mode.
  if (SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)) return ['--segment', checkpoint]
  const scope = process.env.WEWORK_E2E_PARALLEL_SCOPE ?? 'cloud'
  if (scope === 'cloud') return ['--cloud-only', '--segment', checkpoint]
  if (scope === 'core') return ['--segment', checkpoint]
  throw new Error('WEWORK_E2E_PARALLEL_SCOPE must be "cloud" or "core"')
}

async function runRequestedArgs() {
  const parallelCheckpoints = requestedParallelCheckpoints(requestedArgs)
  if (parallelCheckpoints) return runParallelCheckpoints(parallelCheckpoints)

  const checkpoints = requestedCheckpointRange(requestedArgs)
  if (checkpoints) return runCheckpoints(checkpoints)

  const label = requestedArgs.join(' ') || 'desktop task flow'
  const sharedEnv = await sharedBuildEnvironment()
  const segmentIndex = requestedArgs.indexOf('--segment')
  const checkpoint = segmentIndex >= 0 ? requestedArgs[segmentIndex + 1] : undefined
  const env = segmentIndex >= 0 ? checkpointScenarioEnv(sharedEnv, checkpoint) : sharedEnv
  const args = SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)
    ? requestedArgs.filter(argument => argument !== '--cloud-only')
    : requestedArgs
  console.log(`[desktop-e2e] START ${label}`)
  const result = await runTaskFlow(args, env, label)
  if (result.code === 0) {
    console.log(
      `[desktop-e2e] PASS ${label}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
    )
    return
  }
  const failure = await readFailureSummary(result)
  console.error(
    `[desktop-e2e] FAIL ${label}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
  )
  process.exitCode = result.code
}

async function runParallelCheckpoints(checkpoints) {
  const sharedRuntimeDirectory = await mkdtemp(join(tmpdir(), 'wework-e2e-shared-'))
  try {
    const baseEnvironment = await sharedBuildEnvironment()
    const sharedHarnessRuntime =
      baseEnvironment.WEWORK_E2E_HARNESS_RUNTIME_ROOT?.trim() ||
      (await prepareSharedHarnessRuntime(
        baseEnvironment.WEWORK_E2E_APP_BIN,
        sharedRuntimeDirectory
      ))
    const sharedEnv = {
      ...baseEnvironment,
      WEWORK_E2E_HARNESS_RUNTIME_ROOT: sharedHarnessRuntime,
      WEWORK_E2E_PORT_REGISTRY_DIR: sharedRuntimeDirectory,
    }
    const failures = []
    const activeCheckpoints = new Set()
    const workerCount = Math.min(parallelCheckpointLimit(), checkpoints.length)
    const logActivity = (event, checkpoint) => {
      console.log(
        `[desktop-e2e-schedule] ${JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          checkpoint,
          workerCount,
          activeCount: activeCheckpoints.size,
          activeCheckpoints: [...activeCheckpoints],
        })}`
      )
    }
    console.log(
      `[desktop-e2e] Running ${checkpoints.length} checkpoints with ${workerCount} parallel workers`
    )

    await runWithCheckpointResources({
      checkpoints,
      workerCount,
      resourceFor: checkpoint =>
        process.platform === 'darwin' ? CHECKPOINT_RESOURCES.get(checkpoint) : [],
      exclusiveFor: checkpoint => RESOURCE_EXCLUSIVE_CHECKPOINTS.has(checkpoint),
      run: async checkpoint => {
        const env = checkpointScenarioEnv({ ...sharedEnv }, checkpoint)
        delete env.WEWORK_E2E_CONTROL_SERVER_PORT
        delete env.WEWORK_E2E_MODEL_SERVER_PORT
        console.log(`\n[desktop-e2e] START ${checkpoint}`)
        activeCheckpoints.add(checkpoint)
        logActivity('start', checkpoint)
        let result
        try {
          result = await runTaskFlow(parallelCheckpointArgs(checkpoint), env, checkpoint)
        } finally {
          activeCheckpoints.delete(checkpoint)
          logActivity('end', checkpoint)
        }
        if (result.code === 0) {
          console.log(
            `[desktop-e2e] PASS ${checkpoint}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
          )
          return
        }
        const failure = await readFailureSummary(result)
        failures.push({ checkpoint, failure, ...result })
        console.error(
          `[desktop-e2e] FAIL ${checkpoint}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
        )
      },
    })
    if (failures.length === 0) {
      console.log('\n[desktop-e2e] All parallel checkpoints passed.')
      return
    }

    console.error('\n[desktop-e2e] Parallel checkpoint failure summary:')
    for (const failure of failures) {
      console.error(
        `- ${failure.checkpoint}: ${failure.failure}${failure.resultDir ? ` (${failure.resultDir})` : ''}`
      )
    }
    process.exitCode = 1
  } finally {
    await rm(sharedRuntimeDirectory, { recursive: true, force: true })
  }
}

async function runCheckpoints(checkpoints) {
  const sharedEnv = await sharedBuildEnvironment()
  const failures = []

  for (const checkpoint of checkpoints) {
    const env = checkpointScenarioEnv({ ...sharedEnv }, checkpoint)
    console.log(`\n[desktop-e2e] START ${checkpoint}`)
    const args = CLOUD_ONLY_CHECKPOINTS.has(checkpoint)
      ? ['--cloud-only', '--segment', checkpoint]
      : ['--segment', checkpoint]
    const result = await runTaskFlow(args, env, checkpoint)

    if (result.code === 0) {
      console.log(
        `[desktop-e2e] PASS ${checkpoint}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
      )
      continue
    }

    const failure = await readFailureSummary(result)
    failures.push({ checkpoint, failure, ...result })
    console.error(
      `[desktop-e2e] FAIL ${checkpoint}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
    )
  }

  if (failures.length === 0) {
    console.log('\n[desktop-e2e] All checkpoints passed.')
    return
  }

  console.error('\n[desktop-e2e] Checkpoint failure summary:')
  for (const failure of failures) {
    console.error(
      `- ${failure.checkpoint}: ${failure.failure}${failure.resultDir ? ` (${failure.resultDir})` : ''}`
    )
  }
  process.exitCode = 1
}

async function runAllCheckpoints() {
  await runCheckpoints(DEFAULT_DESKTOP_CHECKPOINTS)
}

const previousResults = await compactInactiveDesktopE2EResults(
  resolveDesktopE2EResultRoot(weworkDir)
)
if (previousResults.compacted > 0) {
  console.log(`[desktop-e2e] compacted ${previousResults.compacted} previous result directories`)
}

if (requestedArgs.length > 0) {
  await runRequestedArgs()
} else {
  await runAllCheckpoints()
}
