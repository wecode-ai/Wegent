import { Component, type ErrorInfo, type ReactNode } from 'react'
import { WorkbenchErrorPage } from './WorkbenchErrorPage'

export class WorkbenchErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Wework] Desktop frontend crashed:', error, info.componentStack)
    this.props.onError?.(error)
  }

  render() {
    return this.state.hasError ? <WorkbenchErrorPage /> : this.props.children
  }
}
