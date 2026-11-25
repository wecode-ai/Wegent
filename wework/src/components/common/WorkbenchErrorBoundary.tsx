import { Component, type ErrorInfo, type ReactNode } from 'react'
import { WorkbenchErrorPage } from './WorkbenchErrorPage'

export class WorkbenchErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { failure: { error: unknown; componentStack?: string | null } | null }
> {
  state: { failure: { error: unknown; componentStack?: string | null } | null } = { failure: null }

  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ failure: { error, componentStack: info.componentStack } })
    console.error('[Wework] Desktop frontend crashed:', error, info.componentStack)
    this.props.onError?.(error)
  }

  render() {
    return this.state.failure ? <WorkbenchErrorPage {...this.state.failure} /> : this.props.children
  }
}
