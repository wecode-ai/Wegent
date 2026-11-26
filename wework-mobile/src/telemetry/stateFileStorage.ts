import { File, Paths } from 'expo-file-system'
import type { MobileTelemetryStateStorage } from './state'

const STATE_FILE = 'wework-telemetry-state.json'
const TEMP_FILE = 'wework-telemetry-state.tmp'
const CORRUPT_FILE = 'wework-telemetry-state.corrupt.json'

export function fileTelemetryStorage(): MobileTelemetryStateStorage {
  const stateFile = () => new File(Paths.document, STATE_FILE)
  const temporaryFile = () => new File(Paths.document, TEMP_FILE)
  return {
    async read() {
      const file = stateFile()
      return file.exists ? file.text() : null
    },
    async write(value) {
      const temporary = temporaryFile()
      temporary.create({ overwrite: true })
      temporary.write(value)
      await temporary.move(stateFile(), { overwrite: true })
    },
    async quarantine() {
      const file = stateFile()
      if (!file.exists) return
      await file.move(new File(Paths.document, CORRUPT_FILE), { overwrite: true })
    },
  }
}
