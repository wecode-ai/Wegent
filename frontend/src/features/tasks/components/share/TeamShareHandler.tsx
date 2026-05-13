// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { teamApis, TeamShareInfoResponse } from '@/apis/team'
import { Team } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import Modal from '@/features/common/Modal'

interface TeamShareHandlerProps {
  teams: Team[]
  onRefreshTeams: () => Promise<Team[]>
}

/**
 * Determine the target page based on team's bind_mode.
 * Mirrors the logic in TeamList.tsx getTargetPage.
 */
function getTargetPage(bindMode?: string[]): 'chat' | 'code' {
  if (bindMode && bindMode.length === 1) {
    if (bindMode[0] === 'code') return 'code'
  }
  return 'chat'
}

/**
 * Handle team sharing URL parameter detection, join logic, and modal display
 */
export default function TeamShareHandler({ teams, onRefreshTeams }: TeamShareHandlerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useUser()
  const searchParams = useSearchParams()
  const router = useRouter()

  const [shareInfo, setShareInfo] = useState<TeamShareInfoResponse | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [_isLoading, setIsLoading] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTeamAlreadyJoined = shareInfo ? teams.some(team => team.id === shareInfo.team_id) : false
  const isSelfShare = shareInfo && user && shareInfo.user_id === user.id

  const cleanupUrlParams = React.useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('teamShare')
    router.replace(url.pathname + url.search)
  }, [router])

  const navigateToTeam = (teamId: number, bindMode?: string[]) => {
    const targetPage = getTargetPage(bindMode)
    router.push(`/${targetPage}?teamId=${teamId}`)
  }

  useEffect(() => {
    const teamShareToken = searchParams.get('teamShare')

    if (!teamShareToken) {
      return
    }

    const fetchShareInfo = async () => {
      setIsLoading(true)
      try {
        const info = await teamApis.getTeamShareInfo(encodeURIComponent(teamShareToken))
        setShareInfo(info)
        setIsModalOpen(true)
      } catch {
        console.error('Failed to fetch team share info:', error)
        toast({
          variant: 'destructive',
          title: t('common:teams.share.fetch_info_failed'),
        })
        cleanupUrlParams()
      } finally {
        setIsLoading(false)
      }
    }

    fetchShareInfo()
  }, [searchParams, toast, t, cleanupUrlParams, error])

  const handleConfirmJoin = async () => {
    if (!shareInfo) return

    if (isSelfShare) {
      handleSelfShare()
      return
    }

    if (isTeamAlreadyJoined) {
      // Close modal state without URL cleanup - navigating away handles it
      setIsModalOpen(false)
      setShareInfo(null)
      setError(null)
      navigateToTeam(shareInfo.team_id, shareInfo.bind_mode)
      return
    }

    setIsJoining(true)
    setError(null)
    try {
      await teamApis.joinSharedTeam({ share_token: searchParams.get('teamShare')! })

      toast({
        title: t('common:teams.share.join_success', { teamName: shareInfo?.team_name || '' }),
      })

      // Refresh team list, then navigate to the joined team
      await onRefreshTeams()
      // Close modal state without URL cleanup - navigating away handles it
      setIsModalOpen(false)
      setShareInfo(null)
      setError(null)
      navigateToTeam(shareInfo.team_id, shareInfo.bind_mode)
    } catch (err) {
      console.error('Failed to join shared team:', err)
      const errorMessage = (err as Error)?.message || t('common:teams.share.join_failed')
      toast({
        variant: 'destructive',
        title: errorMessage,
      })
      setError(errorMessage)
    } finally {
      setIsJoining(false)
    }
  }

  const handleCloseModal = () => {
    setIsModalOpen(false)
    setShareInfo(null)
    setError(null)
    cleanupUrlParams()
  }

  const handleSelfShare = () => {
    handleCloseModal()
  }

  const renderMessageWithHighlight = (messageKey: string, teamName: string, userName?: string) => {
    const highlightClass = 'text-lg font-semibold text-blue-600'

    const messageRenderers = {
      'teams.share.self_share_message': () => (
        <span>
          <span className={highlightClass}> {teamName} </span>
          {t('common:teams.share.self_share_suffix')}
        </span>
      ),
      'teams.share.confirm_message': () =>
        userName ? (
          <span>
            {t('common:teams.share.confirm_prefix')}
            <span className={highlightClass}> {userName} </span>
            {t('common:teams.share.confirm_middle')}
            <span className={highlightClass}> {teamName} </span>
            {t('common:teams.share.confirm_suffix')}
          </span>
        ) : null,
      'teams.share.join_description': () => (
        <span>
          {t('common:teams.share.join_description_prefix')}
          <span className="font-semibold"> {teamName} </span>
          {t('common:teams.share.join_description_suffix')}
        </span>
      ),
    }

    const renderer = messageRenderers[messageKey as keyof typeof messageRenderers]
    return renderer ? renderer() : t(messageKey, { teamName, userName })
  }

  if (!shareInfo || !isModalOpen) return null

  return (
    <Modal
      isOpen={isModalOpen}
      onClose={handleCloseModal}
      title={t('common:teams.share.title')}
      maxWidth="md"
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {isSelfShare ? (
          <Alert variant="warning">
            <AlertDescription>
              {renderMessageWithHighlight(
                'common:teams.share.self_share_message',
                shareInfo.team_name
              )}
            </AlertDescription>
          </Alert>
        ) : isTeamAlreadyJoined ? (
          <div className="text-center space-y-2">
            <p className="text-text-primary text-base font-semibold">
              {t('common:teams.share.already_joined_title')}
            </p>
            <p className="text-text-secondary text-sm">
              {t('common:teams.share.already_joined_message', { teamName: shareInfo.team_name })}
            </p>
          </div>
        ) : (
          <>
            <div className="text-center">
              <p className="text-text-primary text-base">
                {renderMessageWithHighlight(
                  'teams.share.confirm_message',
                  shareInfo.team_name,
                  shareInfo.user_name
                )}
              </p>
            </div>

            <Alert variant="default">
              <AlertDescription>
                {renderMessageWithHighlight(
                  'common:teams.share.join_description',
                  shareInfo.team_name
                )}
              </AlertDescription>
            </Alert>
          </>
        )}
      </div>

      <div className="flex space-x-3 mt-6">
        <Button
          onClick={handleCloseModal}
          variant="outline"
          size="sm"
          style={{ flex: 1 }}
          disabled={isJoining}
        >
          {t('common:actions.cancel')}
        </Button>
        {isTeamAlreadyJoined ? (
          <Button
            onClick={handleConfirmJoin}
            variant="primary"
            size="sm"
            style={{ flex: 1 }}
            data-testid="share-start-chat-button"
          >
            {t('common:teams.share.start_chat')}
          </Button>
        ) : (
          <Button
            onClick={handleConfirmJoin}
            variant="default"
            size="sm"
            disabled={!!isSelfShare || isJoining}
            style={{ flex: 1 }}
          >
            {isJoining ? t('common:teams.share.joining') : t('common:teams.share.confirm_join')}
          </Button>
        )}
      </div>
    </Modal>
  )
}
