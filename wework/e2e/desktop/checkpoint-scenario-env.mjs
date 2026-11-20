import { CHECKPOINT_SCENARIO_MODULES, SCENARIO_ONLY_CHECKPOINTS } from './checkpoints.mjs'
import { UPGRADE_DIAGNOSTIC_CHECKPOINTS } from './upgrade-suite.mjs'

export function checkpointScenarioEnv(env, checkpoint) {
  const nextEnv = { ...env }
  if (checkpoint === 'plugin-development' && env.WEWORK_E2E_PLUGIN_DEVELOPMENT_EXECUTOR_BIN) {
    nextEnv.WEWORK_E2E_EXECUTOR_BIN = env.WEWORK_E2E_PLUGIN_DEVELOPMENT_EXECUTOR_BIN
  }
  delete nextEnv.WEWORK_E2E_PLUGIN_DEVELOPMENT_EXECUTOR_BIN
  if (checkpoint === 'temporary-chat') {
    nextEnv.WEWORK_E2E_CONVERSATION_CACHE_IDLE_TTL_MS ??= '10000'
  }
  if (checkpoint === 'coordination-history') {
    nextEnv.WEWORK_E2E_HISTORY_MAINTENANCE_INTERVAL_MS ??= '1000'
    nextEnv.WEWORK_E2E_STAND_IN_POLL_INTERVAL_MS ??= '500'
  }
  if (['stand-in', 'stand-in-cloud', 'stand-in-assignment-notifications'].includes(checkpoint)) {
    nextEnv.WEWORK_E2E_STAND_IN_POLL_INTERVAL_MS ??= '500'
  }
  if (
    ['workspace-attachments', 'clipboard-history-image', 'browser-toolbar-actions'].includes(
      checkpoint
    )
  ) {
    nextEnv.WEWORK_E2E_HOST_PIPE_DIAGNOSTICS = '1'
  }
  if (
    [
      'human-interactions',
      'human-interactions-device-scope',
      'human-interactions-hidden',
      'human-interactions-issue',
      'stand-in-notifications',
    ].includes(checkpoint)
  ) {
    // Narrow 760px-tall content viewports must fit inside the physical display.
    nextEnv.WEWORK_E2E_XVFB_SCREEN = '1280x900x24'
  }
  if (UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint)) {
    nextEnv.WEWORK_E2E_APP_BIN = env.WEWORK_E2E_UPGRADE_SOURCE_APP_BIN || env.WEWORK_E2E_APP_BIN
    nextEnv.WEWORK_E2E_EXECUTOR_BIN =
      env.WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN || env.WEWORK_E2E_EXECUTOR_BIN
    nextEnv.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE = '1'
  }
  if (checkpoint === 'collaboration-shared-core') {
    // Exercise timezone-less UTC API timestamps outside the UTC timezone.
    nextEnv.TZ = 'Asia/Shanghai'
  }
  if (
    checkpoint === 'native-window-chrome' ||
    checkpoint === 'window-lifecycle' ||
    checkpoint === 'core-task-flow' ||
    checkpoint === 'task-completion-notifications' ||
    checkpoint === 'project-assignment-notification' ||
    checkpoint === 'stand-in-profile-settings' ||
    checkpoint === 'stand-in-git' ||
    checkpoint.startsWith('human-interactions')
  ) {
    // Native windows and keyboard input need foreground activation.
    // macOS background mode prohibits activation and hides the app.
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
