import { installProcessOutputErrorHandlers } from './process-output.js'
import { logStartupStep } from './startup-step.js'

installProcessOutputErrorHandlers()

if (process.env.WEWORK_E2E_CORE_CPU_PROFILE === '1') {
  logStartupStep('electron-output-bootstrap', 'completed')
}
