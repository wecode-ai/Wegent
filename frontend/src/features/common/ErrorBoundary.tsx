// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { Component, ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)

    // Check if it's a chunk loading error
    if (error.name === 'ChunkLoadError' || error.message.includes('ChunkLoadError')) {
      console.error(
        'Chunk loading error detected. This might be due to network issues or deployment problems.'
      )
    }
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      // Check if it's specifically a chunk loading error
      const isChunkError =
        this.state.error?.name === 'ChunkLoadError' ||
        this.state.error?.message.includes('ChunkLoadError')

      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-base p-4">
          <div className="max-w-md w-full text-center">
            <div className="mb-4">
              <div className="text-6xl mb-4">⚠️</div>
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                {isChunkError ? '资源加载失败' : '应用出现错误'}
              </h1>
              <p className="text-text-secondary mb-6">
                {isChunkError
                  ? '应用资源加载失败，可能是网络问题或版本更新导致的。请尝试刷新页面。'
                  : '应用遇到了一个意外错误，请尝试刷新页面或联系技术支持。'}
              </p>
            </div>

            <div className="space-y-3">
              <Button variant="default" onClick={this.handleReload} size="lg" className="w-full">
                刷新页面
              </Button>

              {isChunkError && (
                <Button
                  variant="outline"
                  onClick={() => {
                    // Clear cache and reload
                    if ('caches' in window) {
                      caches.keys().then(names => {
                        names.forEach(name => {
                          caches.delete(name)
                        })
                      })
                    }
                    this.handleReload()
                  }}
                  size="lg"
                  className="w-full"
                >
                  清除缓存并刷新
                </Button>
              )}
            </div>

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="mt-6 text-left">
                <summary className="cursor-pointer text-text-secondary hover:text-text-primary">
                  错误详情 (开发模式)
                </summary>
                <pre className="mt-2 p-3 bg-surface border border-border rounded text-xs overflow-auto text-text-secondary">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
