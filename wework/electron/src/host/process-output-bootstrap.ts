import { app } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mainProcessLog } from './main-process-log.js'
import { installProcessOutputErrorHandlers } from './process-output.js'

installProcessOutputErrorHandlers()

const bootstrapLogPath =
  process.env.WEWORK_MAIN_LOG_PATH?.trim() ||
  (() => {
    try {
      return join(app.getPath('userData'), 'logs', 'wework-startup-bootstrap.log')
    } catch {
      return join(tmpdir(), 'wework-startup-bootstrap.log')
    }
  })()

void mainProcessLog.setPath(bootstrapLogPath)
mainProcessLog.install()
