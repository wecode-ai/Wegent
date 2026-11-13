// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import client, { ApiError } from '@/apis/client'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import { isManager } from '@/types/base-role'
import type { MyPermissionSourcesResponse } from '@/types/knowledge'
import { KnowledgeAuthorizationObjects } from '../../permission/components/KnowledgeAuthorizationObjects'
import { KnowledgePermissionSources } from './KnowledgePermissionSources'

interface KnowledgeAccessDialogProps {
  restoreFocus?: () => void
  resourceCreated?: boolean
  refreshError?: string | null
  onRetryRefresh?: () => void
  kbId: number
  kbNamespace?: string
  canManage?: boolean
  onClose: () => void
  onChanged: () => void
  onAccessLost: () => void
}

export function KnowledgeAccessDialog(props: KnowledgeAccessDialogProps) {
  const { user } = useUser()
  const scope = JSON.stringify([user?.id, client.getCacheScope(), props.kbId])
  const activeScope = useRef({ key: scope, version: 0 })
  if (activeScope.current.key !== scope)
    activeScope.current = { key: scope, version: activeScope.current.version + 1 }
  const version = activeScope.current.version
  return (
    <KnowledgeAccessSession
      key={scope}
      {...props}
      onChanged={() => {
        if (activeScope.current.version === version) props.onChanged()
      }}
    />
  )
}

function KnowledgeAccessSession(props: KnowledgeAccessDialogProps) {
  const { t } = useTranslation('knowledge')
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const callbacks = useRef(props)
  callbacks.current = props
  const [sources, setSources] = useState<MyPermissionSourcesResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    const lost = () => {
      callbacks.current.onAccessLost()
      callbacks.current.onClose()
    }
    knowledgePermissionApi
      .getMyPermissionSources(props.kbId)
      .then(result => {
        if (cancelled) return
        if (!result.has_access) {
          setSources(null)
          lost()
        } else {
          setSources(result)
        }
      })
      .catch(error => {
        if (cancelled) return
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) lost()
        else setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [props.kbId, props.canManage, attempt])

  const changed = () => {
    if (alive.current) setAttempt(value => value + 1)
    callbacks.current.onChanged()
  }
  const canManage =
    !blocked &&
    props.canManage !== false &&
    sources?.has_access &&
    (sources.is_creator || isManager(sources.effective_role))
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (props.resourceCreated && props.restoreFocus) {
            props.restoreFocus()
            return
          }
          const target = returnFocus.current
          if (target?.isConnected && !target.closest('[role="dialog"]')) target.focus()
          else props.restoreFocus?.()
        }}
        className="max-h-[90dvh] min-w-0 w-[calc(100%_-_1rem)] max-w-3xl grid-cols-[minmax(0,1fr)] overflow-y-auto max-md:p-4"
        closeButtonProps={{
          className: 'min-h-11 min-w-11 flex items-center justify-center',
          'data-testid': 'close-knowledge-access',
        }}
      >
        <DialogHeader className="pr-10 text-left">
          <DialogTitle>
            {t(
              props.resourceCreated
                ? 'document.creation.created'
                : 'document.navigation.permissionDetails'
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {t(
            props.resourceCreated
              ? 'document.creation.createdDescription'
              : 'document.navigation.permissionDescription'
          )}
        </DialogDescription>
        {props.refreshError && (
          <div role="alert">
            {t('document.creation.refreshFailed')}
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              data-testid="retry-created-list"
              onClick={props.onRetryRefresh}
            >
              {t('document.navigation.retry')}
            </Button>
          </div>
        )}
        {(failed || blocked) && (
          <div role="alert">
            {t(
              blocked
                ? 'document.navigation.managementUnavailable'
                : 'document.navigation.permissionFailed'
            )}
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              data-testid="retry-permission-sources"
              onClick={() => {
                setSources(null)
                setBlocked(false)
                setAttempt(value => value + 1)
              }}
            >
              {t('document.navigation.retry')}
            </Button>
          </div>
        )}
        {!sources && !failed && <p role="status">{t('loading')}</p>}
        {sources && <KnowledgePermissionSources permission={sources} />}
        {sources?.has_access && (
          <KnowledgeAuthorizationObjects
            kbId={props.kbId}
            kbNamespace={props.kbNamespace}
            canManage={Boolean(canManage)}
            onChanged={changed}
            onAccessDenied={() => {
              if (alive.current) setBlocked(true)
              changed()
            }}
          />
        )}
        {props.resourceCreated && (
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            data-testid="finish-created-authorization"
            onClick={props.onClose}
          >
            {t('document.creation.finishLater')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
