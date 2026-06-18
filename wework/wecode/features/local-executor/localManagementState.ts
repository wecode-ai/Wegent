import type {
  ExecutorAction,
  ExecutorProcessDiagnostics,
  ExecutorStatus,
  StartupEnvVar,
} from '@wecode/api/local-executor'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface LocalExecutorState {
  status: ExecutorStatus | null
  diagnostics: ExecutorProcessDiagnostics | null
  envVars: StartupEnvVar[]
  isLoading: boolean
  isMutating: boolean
  activeAction: ExecutorAction | null
  isOpeningLogs: boolean
  isCleaningProcesses: boolean
  isSavingEnv: boolean
  envExpanded: boolean
  error: string | null
  message: string | null
  commandOutput: string
  commandSucceeded: boolean | null
  commandExitCode: number | null
}

export const initialLocalExecutorState: LocalExecutorState = {
  status: null,
  diagnostics: null,
  envVars: [],
  isLoading: true,
  isMutating: false,
  activeAction: null,
  isOpeningLogs: false,
  isCleaningProcesses: false,
  isSavingEnv: false,
  envExpanded: false,
  error: null,
  message: null,
  commandOutput: '',
  commandSucceeded: null,
  commandExitCode: null,
}

export function canSaveEnvVars(envVars: StartupEnvVar[]): boolean {
  return envVars.every(envVar => ENV_KEY_PATTERN.test(envVar.key.trim()))
}
