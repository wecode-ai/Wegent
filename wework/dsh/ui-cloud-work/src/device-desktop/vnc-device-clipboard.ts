import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

const VNC_CLIPBOARD_TIMEOUT_SECONDS = 10
// Reads come back through process stdout, which the platform does not cap.
const VNC_CLIPBOARD_READ_MAX_BYTES = 1024 * 1024
const VNC_CLIPBOARD_READ_BASE64_MAX_BYTES = Math.ceil(VNC_CLIPBOARD_READ_MAX_BYTES / 3) * 4 + 16
// Writes travel as one environment variable. Linux caps a single env entry at
// MAX_ARG_STRLEN (128 KiB on 4 KiB pages) and base64 inflates by 4/3, so the
// payload must stay far below it: above the cap the remote process never starts
// and the write fails with a bare E2BIG instead of a clipboard error.
const VNC_CLIPBOARD_WRITE_MAX_BYTES = 32 * 1024
const VNC_CLIPBOARD_WRITE_MAX_KIB = VNC_CLIPBOARD_WRITE_MAX_BYTES / 1024

export interface VncDeviceClipboardBridge {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export class VncClipboardWriteTooLargeError extends Error {
  constructor() {
    super(
      `The clipboard text exceeds the ${VNC_CLIPBOARD_WRITE_MAX_KIB} KiB limit for the virtual desktop`
    )
    this.name = 'VncClipboardWriteTooLargeError'
  }
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > VNC_CLIPBOARD_WRITE_MAX_BYTES) {
    throw new VncClipboardWriteTooLargeError()
  }
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function decodeUtf8Base64(value: string): string {
  const binary = atob(value)
  if (binary.length > VNC_CLIPBOARD_READ_MAX_BYTES) {
    throw new Error('The VNC clipboard payload is too large')
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function commandOutputText(output: unknown): string {
  if (typeof output !== 'string') throw new Error('Unexpected VNC clipboard response')
  return output.trim()
}

export function createVncDeviceClipboardBridge(
  deviceApi: WorkbenchServices['deviceApi'],
  deviceId: string
): VncDeviceClipboardBridge {
  return {
    async readText() {
      const response = await deviceApi.executeCommand(deviceId, {
        command_key: 'vnc_clipboard_read',
        timeout_seconds: VNC_CLIPBOARD_TIMEOUT_SECONDS,
        max_output_bytes: VNC_CLIPBOARD_READ_BASE64_MAX_BYTES,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to read the VNC clipboard')
      }
      return decodeUtf8Base64(commandOutputText(response.stdout))
    },
    async writeText(text) {
      const response = await deviceApi.executeCommand(deviceId, {
        command_key: 'vnc_clipboard_write',
        env: { WEWORK_VNC_CLIPBOARD_BASE64: encodeUtf8Base64(text) },
        timeout_seconds: VNC_CLIPBOARD_TIMEOUT_SECONDS,
        max_output_bytes: 4096,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to write the VNC clipboard')
      }
    },
  }
}
