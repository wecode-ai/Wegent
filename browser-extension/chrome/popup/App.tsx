// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useCallback } from 'react'
import browser from 'webextension-polyfill'
import { isAuthenticated, getStoredUser, logout } from '@shared/api'
import { getStorageValue } from '@shared/storage'
import type { User } from '@shared/api/types'
import type { ExtractedContent } from '@shared/extractor'
import LoginForm from './components/LoginForm'
import Header from './components/Header'
import ContentPreview from './components/ContentPreview'
import ChatSection from './components/ChatSection'
import KnowledgeSection from './components/KnowledgeSection'
import SettingsPanel from './components/SettingsPanel'

type ExtractionMode = 'selection' | 'fullPage'
type View = 'main' | 'settings'

interface PendingAction {
  action: 'chat' | 'knowledge' | null
  text: string
  url: string
  title: string
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [view, setView] = useState<View>('main')
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('selection')
  const [content, setContent] = useState<ExtractedContent | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  // Check authentication status on mount
  useEffect(() => {
    checkAuth()
    loadDefaultSettings()
    checkPendingAction()
  }, [])

  // Extract content when mode changes
  useEffect(() => {
    if (isLoggedIn && !pendingAction?.text) {
      extractContent(extractionMode)
    }
  }, [extractionMode, isLoggedIn, pendingAction?.text, extractContent])

  const checkAuth = async () => {
    try {
      const authenticated = await isAuthenticated()
      setIsLoggedIn(authenticated)

      if (authenticated) {
        const storedUser = await getStoredUser()
        if (storedUser) {
          setUser(storedUser)
        }
      }
    } catch {
      setIsLoggedIn(false)
    }
  }

  const loadDefaultSettings = async () => {
    const mode = await getStorageValue('defaultExtractionMode')
    if (mode) {
      setExtractionMode(mode)
    }
  }

  const checkPendingAction = async () => {
    const result = await browser.storage.local.get([
      'pendingAction',
      'pendingText',
      'pendingUrl',
      'pendingTitle',
    ])

    if (result.pendingAction) {
      setPendingAction({
        action: result.pendingAction as 'chat' | 'knowledge',
        text: result.pendingText || '',
        url: result.pendingUrl || '',
        title: result.pendingTitle || '',
      })

      // Clear the pending action
      await browser.runtime.sendMessage({ type: 'CLEAR_PENDING_ACTION' })
    }
  }

  const extractContent = useCallback(
    async (mode: ExtractionMode) => {
      setIsLoading(true)
      setError(null)

      try {
        const messageType = mode === 'selection' ? 'GET_SELECTED_TEXT' : 'GET_PAGE_CONTENT'
        const response = await browser.runtime.sendMessage({ type: messageType })

        if (response?.error) {
          throw new Error(response.error)
        }

        if (response?.success && response.data) {
          setContent(response.data)
        } else if (mode === 'selection' && !response?.data) {
          // No selection, try full page
          const pageResponse = await browser.runtime.sendMessage({
            type: 'GET_PAGE_CONTENT',
          })
          if (pageResponse?.success && pageResponse.data) {
            setContent(pageResponse.data)
            setExtractionMode('fullPage')
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to extract content')
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  const handleLoginSuccess = () => {
    checkAuth()
  }

  const handleLogout = async () => {
    await logout()
    setIsLoggedIn(false)
    setUser(null)
  }

  // Show loading state while checking auth
  if (isLoggedIn === null) {
    return (
      <div className="flex h-[520px] w-[400px] items-center justify-center bg-base">
        <div className="text-text-secondary">Loading...</div>
      </div>
    )
  }

  // Show login form if not authenticated
  if (!isLoggedIn) {
    return <LoginForm onSuccess={handleLoginSuccess} />
  }

  // Build content from pending action or extracted content
  const displayContent = pendingAction?.text
    ? {
        text: pendingAction.text,
        markdown: pendingAction.text,
        metadata: {
          title: pendingAction.title,
          url: pendingAction.url,
        },
        extractedAt: new Date().toISOString(),
      }
    : content

  return (
    <div className="flex h-[520px] w-[400px] flex-col bg-base">
      <Header
        user={user}
        onLogout={handleLogout}
        onSettingsClick={() => setView(view === 'settings' ? 'main' : 'settings')}
        isSettingsOpen={view === 'settings'}
      />

      {view === 'settings' ? (
        <SettingsPanel onClose={() => setView('main')} />
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Content Preview */}
          <ContentPreview
            content={displayContent}
            extractionMode={extractionMode}
            onModeChange={setExtractionMode}
            isLoading={isLoading}
            error={error}
            isPendingAction={!!pendingAction?.text}
          />

          {/* Chat Section */}
          <ChatSection
            content={displayContent}
            defaultExpanded={pendingAction?.action === 'chat'}
          />

          {/* Knowledge Base Section */}
          <KnowledgeSection
            content={displayContent}
            defaultExpanded={pendingAction?.action === 'knowledge'}
          />
        </div>
      )}
    </div>
  )
}

export default App
