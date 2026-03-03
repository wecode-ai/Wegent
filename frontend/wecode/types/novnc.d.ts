// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Type declarations for @novnc/novnc RFB module.
 *
 * noVNC is a JavaScript VNC client library. RFB (Remote Framebuffer)
 * is the core class that handles VNC protocol communication.
 *
 * The package uses "lib/rfb" as the actual module path (CJS compiled).
 * We also declare "core/rfb" for compatibility with noVNC documentation.
 */

interface RFBCredentials {
  username?: string
  password?: string
  target?: string
}

interface RFBCapabilities {
  power: boolean
}

type RFBEventMap = {
  connect: CustomEvent
  disconnect: CustomEvent<{ clean: boolean }>
  credentialsrequired: CustomEvent
  securityfailure: CustomEvent<{ status: number; reason: string }>
  clipboard: CustomEvent<{ text: string }>
  bell: CustomEvent
  desktopname: CustomEvent<{ name: string }>
  capabilities: CustomEvent<{ capabilities: RFBCapabilities }>
}

declare class RFB {
  constructor(
    target: HTMLElement,
    urlOrChannel: string | WebSocket,
    options?: {
      shared?: boolean
      credentials?: RFBCredentials
      repeaterID?: string
      wsProtocols?: string[]
    }
  )

  // Properties
  viewOnly: boolean
  focusOnClick: boolean
  clipViewport: boolean
  dragViewport: boolean
  scaleViewport: boolean
  resizeSession: boolean
  showDotCursor: boolean
  background: string
  qualityLevel: number
  compressionLevel: number
  readonly capabilities: RFBCapabilities

  // Methods
  disconnect(): void
  sendCredentials(credentials: RFBCredentials): void
  sendKey(keysym: number, code: string | null, down?: boolean): void
  sendCtrlAltDel(): void
  focus(): void
  blur(): void
  machineShutdown(): void
  machineReboot(): void
  machineReset(): void
  clipboardPasteFrom(text: string): void
  getImageData(): ImageData

  // Event handling
  addEventListener<K extends keyof RFBEventMap>(
    type: K,
    listener: (ev: RFBEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener<K extends keyof RFBEventMap>(
    type: K,
    listener: (ev: RFBEventMap[K]) => void,
    options?: boolean | EventListenerOptions
  ): void
}

declare module '@novnc/novnc/lib/rfb' {
  export default RFB
}

declare module '@novnc/novnc/lib/rfb.js' {
  export default RFB
}

declare module '@novnc/novnc/core/rfb' {
  export default RFB
}
