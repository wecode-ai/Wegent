export interface WindowClosePreferences {
  closeToTrayEnabled: boolean
  closeToTrayHintSeen: boolean
}

export interface WindowClosePreferenceAccess {
  read(): Promise<WindowClosePreferences>
  markCloseToTrayHintSeen(): Promise<void>
}

export type WindowClosePolicyState =
  | { status: 'idle' }
  | { status: 'awaiting-close-to-tray-confirmation' }

export type WindowClosePolicyEvent =
  | { type: 'close-requested'; quitting: true }
  | {
      type: 'close-requested'
      quitting: false
      preferences: WindowClosePreferences
    }
  | { type: 'close-to-tray-confirmed' }
  | { type: 'close-to-tray-cancelled' }

export type WindowCloseDecision =
  | { type: 'allow-close' }
  | { type: 'request-quit' }
  | { type: 'show-close-to-tray-confirmation' }
  | { type: 'hide-to-background' }
  | { type: 'no-action' }

export interface WindowCloseTransition {
  state: WindowClosePolicyState
  decision: WindowCloseDecision
  persistCloseToTrayHintSeen: boolean
}

export const initialWindowClosePolicyState: WindowClosePolicyState = {
  status: 'idle',
}

export function transitionWindowClosePolicy(
  state: WindowClosePolicyState,
  event: WindowClosePolicyEvent
): WindowCloseTransition {
  if (event.type === 'close-requested') {
    if (event.quitting) {
      return transitionToIdle({ type: 'allow-close' })
    }
    if (!event.preferences.closeToTrayEnabled) {
      return transitionToIdle({ type: 'request-quit' })
    }
    if (event.preferences.closeToTrayHintSeen) {
      return transitionToIdle({ type: 'hide-to-background' })
    }
    if (state.status === 'awaiting-close-to-tray-confirmation') {
      return unchanged(state)
    }
    return {
      state: { status: 'awaiting-close-to-tray-confirmation' },
      decision: { type: 'show-close-to-tray-confirmation' },
      persistCloseToTrayHintSeen: false,
    }
  }

  if (state.status !== 'awaiting-close-to-tray-confirmation') {
    throw new Error(`Cannot handle ${event.type} without a pending close-to-tray confirmation`)
  }
  if (event.type === 'close-to-tray-cancelled') {
    return transitionToIdle({ type: 'no-action' })
  }
  return {
    state: initialWindowClosePolicyState,
    decision: { type: 'hide-to-background' },
    persistCloseToTrayHintSeen: true,
  }
}

export class WindowClosePolicy {
  private state: WindowClosePolicyState = initialWindowClosePolicyState

  constructor(private readonly preferences: WindowClosePreferenceAccess) {}

  async requestClose(quitting: boolean): Promise<WindowCloseDecision> {
    const event: WindowClosePolicyEvent = quitting
      ? { type: 'close-requested', quitting: true }
      : {
          type: 'close-requested',
          quitting: false,
          preferences: await this.preferences.read(),
        }
    return this.apply(event)
  }

  confirmCloseToTray(): Promise<WindowCloseDecision> {
    return this.apply({ type: 'close-to-tray-confirmed' })
  }

  cancelCloseToTray(): Promise<WindowCloseDecision> {
    return this.apply({ type: 'close-to-tray-cancelled' })
  }

  currentState(): WindowClosePolicyState {
    return this.state
  }

  private async apply(event: WindowClosePolicyEvent): Promise<WindowCloseDecision> {
    const transition = transitionWindowClosePolicy(this.state, event)
    if (transition.persistCloseToTrayHintSeen) {
      await this.preferences.markCloseToTrayHintSeen()
    }
    this.state = transition.state
    return transition.decision
  }
}

function transitionToIdle(decision: WindowCloseDecision): WindowCloseTransition {
  return {
    state: initialWindowClosePolicyState,
    decision,
    persistCloseToTrayHintSeen: false,
  }
}

function unchanged(state: WindowClosePolicyState): WindowCloseTransition {
  return {
    state,
    decision: { type: 'no-action' },
    persistCloseToTrayHintSeen: false,
  }
}
