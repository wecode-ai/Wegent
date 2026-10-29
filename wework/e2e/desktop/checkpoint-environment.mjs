import { UPGRADE_PACKAGE_CHECKPOINTS } from './upgrade-suite.mjs'

export function checkpointScenarioEnv(
  env,
  checkpoint,
  { scenarioModules, scenarioOnlyCheckpoints }
) {
  const nextEnv = { ...env }
  if (UPGRADE_PACKAGE_CHECKPOINTS.includes(checkpoint)) {
    nextEnv.WEWORK_E2E_APP_BIN = env.WEWORK_E2E_UPGRADE_SOURCE_APP_BIN || env.WEWORK_E2E_APP_BIN
    nextEnv.WEWORK_E2E_EXECUTOR_BIN =
      env.WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN || env.WEWORK_E2E_EXECUTOR_BIN
    nextEnv.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE = '1'
  }
  if (checkpoint === 'collaboration-shared-core') {
    // Exercise timezone-less UTC API timestamps outside the UTC timezone.
    nextEnv.TZ = 'Asia/Shanghai'
  }
  if (checkpoint === 'claude-runtime') {
    // Make native MCP discovery deterministic regardless of tool catalog size.
    nextEnv.ENABLE_TOOL_SEARCH = 'true'
  }
  if (
    checkpoint === 'application-menu' ||
    checkpoint === 'native-window-chrome' ||
    checkpoint === 'window-lifecycle' ||
    checkpoint === 'browser-multi-tabs' ||
    checkpoint === 'core-task-flow' ||
    checkpoint === 'project-assignment-notification'
  ) {
    // These checks present native auxiliary windows and must observe them as
    // visible. macOS background mode prohibits activation and hides the app.
    // Assignment notification also verifies tag commits through native focus loss.
    nextEnv.WEWORK_E2E_BACKGROUND_WINDOW = '0'
  }
  const module = scenarioModules[checkpoint]
  if (module) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE = module
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE
  }
  if (scenarioOnlyCheckpoints.has(checkpoint)) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY = 'true'
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY
  }
  return nextEnv
}
