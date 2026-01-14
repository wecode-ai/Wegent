'use client'

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react'
import type { DataVersion } from '@/types'
import { getVersions, getLatestVersion } from '@/apis/version'

interface VersionContextType {
  versions: DataVersion[]
  currentVersion: DataVersion | null
  setCurrentVersion: (version: DataVersion) => void
  isLoading: boolean
  error: string | null
  refreshVersions: () => Promise<void>
}

const VersionContext = createContext<VersionContextType | undefined>(undefined)

export function VersionProvider({ children }: { children: ReactNode }) {
  const [versions, setVersions] = useState<DataVersion[]>([])
  const [currentVersion, setCurrentVersionState] = useState<DataVersion | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refreshVersions = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const data = await getVersions()
      setVersions(data.items)

      // If no current version selected, select the latest
      if (!currentVersion && data.items.length > 0) {
        setCurrentVersionState(data.items[0]) // items are ordered by id desc
      } else if (currentVersion) {
        // Update current version data if it exists
        const updated = data.items.find(v => v.id === currentVersion.id)
        if (updated) {
          setCurrentVersionState(updated)
        } else if (data.items.length > 0) {
          setCurrentVersionState(data.items[0])
        }
      }
    } catch (err) {
      console.error('Failed to fetch versions:', err)
      setError('Failed to load versions')
    } finally {
      setIsLoading(false)
    }
  }, [currentVersion])

  useEffect(() => {
    refreshVersions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setCurrentVersion = (version: DataVersion) => {
    setCurrentVersionState(version)
  }

  return (
    <VersionContext.Provider
      value={{
        versions,
        currentVersion,
        setCurrentVersion,
        isLoading,
        error,
        refreshVersions,
      }}
    >
      {children}
    </VersionContext.Provider>
  )
}

export function useVersion() {
  const context = useContext(VersionContext)
  if (!context) {
    throw new Error('useVersion must be used within a VersionProvider')
  }
  return context
}
