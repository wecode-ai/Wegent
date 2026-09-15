declare module '@novnc/novnc' {
  type RfbCredentials = {
    password?: string
    target?: string
    username?: string
  }

  type RfbOptions = {
    credentials?: RfbCredentials
    shared?: boolean
  }

  interface RfbEventMap {
    clipboard: CustomEvent<{ text?: string }>
    connect: Event
    disconnect: CustomEvent<{ clean?: boolean }>
    securityfailure: CustomEvent<{ reason?: string }>
  }

  export default class RFB extends EventTarget {
    clipViewport: boolean
    compressionLevel: number
    qualityLevel: number
    resizeSession: boolean
    scaleViewport: boolean
    viewOnly: boolean
    focusOnClick: boolean

    constructor(target: HTMLElement, url: string, options?: RfbOptions)

    addEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions
    ): void
    removeEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
      options?: boolean | EventListenerOptions
    ): void
    clipboardPasteFrom(text: string): void
    disconnect(): void
    focus(): void
    sendCtrlAltDel(): void
  }
}
