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

  // Define extractContent first to avoid TDZ (Temporal Dead Zone) issues in Safari
  const extractContent = useCallback(
    async (mode: ExtractionMode) => {
      console.log('[Wegent Popup] extractContent called with mode:', mode)
      setIsLoading(true)
      setError(null)

      try {
        const messageType = mode === 'selection' ? 'GET_SELECTED_TEXT' : 'GET_PAGE_CONTENT'
        console.log('[Wegent Popup] Sending message to service worker:', messageType)
        const response = await browser.runtime.sendMessage({ type: messageType })
        console.log('[Wegent Popup] Received response:', response)

        if (response?.error) {
          console.error('[Wegent Popup] Response contains error:', response.error)
          throw new Error(response.error)
        }

        if (response?.success && response.data) {
          console.log('[Wegent Popup] Content extracted successfully')
          setContent(response.data)
        } else if (mode === 'selection' && !response?.data) {
          // No selection, try full page
          console.log('[Wegent Popup] No selection found, trying full page extraction')
          const pageResponse = await browser.runtime.sendMessage({
            type: 'GET_PAGE_CONTENT',
          })
          console.log('[Wegent Popup] Full page response:', pageResponse)
          if (pageResponse?.success && pageResponse.data) {
            setContent(pageResponse.data)
            setExtractionMode('fullPage')
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to extract content'
        console.error('[Wegent Popup] Error extracting content:', errorMessage, err)
        setError(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
