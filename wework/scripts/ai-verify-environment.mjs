import { join } from 'node:path'

const INHERITED_RUNTIME_ENV_KEYS = [
  'CODEX_BINARY_PATH',
  'DWS_BINARY_PATH',
  'ELECTRON_RUN_AS_NODE',
  'WEGENT_APP_LIFECYCLE_FD',
  'WEGENT_EXECUTOR_APP_IPC_ADDR',
  'WEGENT_EXECUTOR_APP_IPC_ADDR_FILE',
  'WEGENT_EXECUTOR_APP_IPC_SOCKET',
  'WEGENT_EXECUTOR_BINARY',
  'WEGENT_EXECUTOR_SOURCE_DIR',
  'WEGENT_APP_IPC_DEVICE_ID',
  'WEGENT_APP_IPC_ENDPOINT',
  'WEGENT_APP_IPC_OWNER_TOKEN',
  'WEGENT_APP_IPC_TOKEN',
  'WEGENT_TASK_ID',
  'WEGENT_TASK_WORKSPACE',
  'WEWORK_COMPONENT_RESOURCES_ROOT',
  'WEWORK_APP_HOT_RELOAD',
  'WEWORK_DEV_BRANCH',
  'WEWORK_DEV_DOCK_TITLE',
  'WEWORK_DEV_EXECUTABLE_NAME',
  'WEWORK_DEV_INSTANCE_ID',
  'WEWORK_DEV_INSTANCE_LABEL',
  'WEWORK_DEV_TITLE',
  'WEWORK_DEV_WORKTREE',
  'WEWORK_EXECUTOR_PATH',
  'WEWORK_EXECUTOR_SIDECAR',
  'WEWORK_HARNESS_RUNTIME_ROOT',
  'WEWORK_NODE_PATH',
  'WEWORK_NODE_RUNTIME_KIND',
  'WEWORK_PARENT_PROJECT',
  'WEWORK_PARENT_TITLE',
  'WEWORK_PARENT_WORKSPACE',
  'WEWORK_RUNTIME_BIN',
  'WEWORK_SHARED_EXECUTOR_HOME',
]

export function isolateAiVerifyRuntimeEnvironment(processEnvironment) {
  const isolatedEnvironment = { ...processEnvironment }
  for (const key of INHERITED_RUNTIME_ENV_KEYS) delete isolatedEnvironment[key]
  return isolatedEnvironment
}

export function buildAiVerifyEnvironment(
  processEnvironment,
  {
    controlUrl,
    token,
    codexHome,
    nativeCodexHome,
    verifyCodexHomeInitialization,
    deviceId,
    appIdentifier,
    executorHome,
    sessionDirectory,
  }
) {
  const isolatedEnvironment = isolateAiVerifyRuntimeEnvironment(processEnvironment)

  return {
    ...isolatedEnvironment,
    VITE_WEWORK_E2E: 'true',
    VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
    VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN: token,
    WEWORK_E2E_CONTROL_TOKEN: token,
    WEWORK_E2E_CONTROL_URL: controlUrl,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    ...(nativeCodexHome ? { WEWORK_E2E_NATIVE_CODEX_HOME: nativeCodexHome } : {}),
    ...(verifyCodexHomeInitialization ? { VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION: 'true' } : {}),
    DEVICE_ID: deviceId,
    WEWORK_APP_IDENTIFIER: appIdentifier,
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
    WEGENT_EXECUTOR_HOME: executorHome,
    WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'true',
    WEWORK_DISABLE_BACKGROUND_THROTTLING: '1',
    WEGENT_EXECUTOR_PROJECTS_DIR: join(executorHome, 'workspace', 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: sessionDirectory,
    WEWORK_APP_CONFIG_DIR: join(sessionDirectory, 'app-config'),
  }
}
