// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react'
import {
  getStorageValue,
  setStorageValue,
  getAllStorageData,
  clearAllStorageData,
} from '@shared/storage'

interface SettingsPanelProps {
  onClose: () => void
}

function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [serverUrl, setServerUrl] = useState('')
  const [defaultMode, setDefaultMode] = useState<'selection' | 'fullPage'>('selection')
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    const data = await getAllStorageData()
    if (data.serverUrl) {
      setServerUrl(data.serverUrl)
    }
    if (data.defaultExtractionMode) {
      setDefaultMode(data.defaultExtractionMode)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    setSaveMessage(null)

    try {
      await setStorageValue('serverUrl', serverUrl)
      await setStorageValue('defaultExtractionMode', defaultMode)

      setSaveMessage('Settings saved successfully!')
      setTimeout(() => setSaveMessage(null), 2000)
    } catch {
      setSaveMessage('Failed to save settings')
    } finally {
      setIsSaving(false)
    }
  }

  const handleClearData = async () => {
    if (confirm('Are you sure you want to clear all extension data? This will log you out.')) {
      await clearAllStorageData()
      window.location.reload()
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-text-secondary hover:bg-surface hover:text-text-primary"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <div className="space-y-4">
        {/* Server URL */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-secondary">
            Wegent Server URL
          </label>
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://wegent.example.com"
            className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
          />
          <p className="mt-1 text-xs text-text-muted">
            The URL of your Wegent server (supports private deployments)
          </p>
        </div>

        {/* Default Extraction Mode */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-secondary">
            Default Content Extraction
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setDefaultMode('selection')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                defaultMode === 'selection'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface text-text-secondary hover:text-text-primary'
              }`}
            >
              Selected Text
            </button>
            <button
              onClick={() => setDefaultMode('fullPage')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                defaultMode === 'fullPage'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface text-text-secondary hover:text-text-primary'
              }`}
            >
              Full Page
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Choose the default mode for extracting content from web pages
          </p>
        </div>

        {/* Save Message */}
        {saveMessage && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              saveMessage.includes('success')
                ? 'bg-green-50 text-green-600'
                : 'bg-red-50 text-red-600'
            }`}
          >
            {saveMessage}
          </div>
        )}

        {/* Save Button */}
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-60"
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>

        {/* Divider */}
        <hr className="border-border" />

        {/* Clear Data */}
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-secondary">Danger Zone</h3>
          <button
            onClick={handleClearData}
            className="w-full rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-100"
          >
            Clear All Data
          </button>
          <p className="mt-1 text-xs text-text-muted">
            This will remove all saved settings and log you out
          </p>
        </div>
      </div>

      {/* Version Info */}
      <div className="mt-auto pt-4">
        <p className="text-center text-xs text-text-muted">
          Wegent Browser Extension v1.0.0
        </p>
      </div>
    </div>
  )
}

export default SettingsPanel
