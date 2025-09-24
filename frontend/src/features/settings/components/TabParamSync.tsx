// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

interface TabParamSyncProps {
  tabIndex: number
  setTabIndex: (index: number) => void
}

export default function TabParamSync({ tabIndex, setTabIndex }: TabParamSyncProps) {
  const searchParams = useSearchParams()
  
  // Tab name to index mapping parameterization
  const tabNameToIndex: Record<string, number> = {
    integrations: 0,
    bots: 1,
    bot: 1,
    team: 2
  }
  useEffect(() => {
    const tab = searchParams?.get('tab')
    if (tab && tabNameToIndex.hasOwnProperty(tab)) {
      setTabIndex(tabNameToIndex[tab])
    } else {
      setTabIndex(0)
    }
  }, [searchParams, setTabIndex])
  
  return null // This component doesn't render anything, only handles logic
}