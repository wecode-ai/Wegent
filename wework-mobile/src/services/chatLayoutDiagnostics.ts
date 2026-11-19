import { recordMobileDiagnostic } from './mobileDiagnostics'

/** The layout hook supplies geometry and counters only; no content or identifiers. */
export function recordChatLayoutDiagnostic(record: string): void {
  recordMobileDiagnostic('[ChatLayout]', record)
}
