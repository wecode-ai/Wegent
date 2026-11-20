/** Native browser chrome nodes carry DOM identity, never a connection or navigation command. */
export function createBrowserSessionDom() {
  const browserHostRef: { current: HTMLDivElement | null } = { current: null }
  const browserPanelRef: { current: HTMLDivElement | null } = { current: null }
  const addressInputRef: { current: HTMLInputElement | null } = { current: null }
  const rootRef = { current: document.documentElement }
  return {
    readHost: () => browserHostRef.current,
    readAddressInput: () => addressInputRef.current,
    browserPanelRef,
    geometryTargets: [browserHostRef, browserPanelRef, rootRef],
    bindPanel: (element: HTMLDivElement | null) => {
      browserPanelRef.current = element
    },
    bindHost: (element: HTMLDivElement | null) => {
      browserHostRef.current = element
    },
    bindAddressInput: (element: HTMLInputElement | null) => {
      addressInputRef.current = element
    },
  }
}
