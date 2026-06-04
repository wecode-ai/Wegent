// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError } from '@/apis/client'
import { userApis } from '@/apis/user'
import { WeiboBindingSettings } from '@/features/settings/components/WeiboBindingSettings'

const mockToast = jest.fn()
const mockRefresh = jest.fn()
let mockUser: Record<string, unknown> | null = null

jest.mock('@/apis/user', () => ({
  userApis: {
    previewWeiboAccount: jest.fn(),
    bindWeiboAccount: jest.fn(),
    unbindWeiboAccount: jest.fn(),
  },
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: mockUser,
    refresh: mockRefresh,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'weiboBinding.title': 'Weibo Account Binding',
        'weiboBinding.description': 'Bind current Weibo account',
        'weiboBinding.boundDescription': 'Bound to a Weibo UID',
        'weiboBinding.uidLabel': 'Weibo UID',
        'weiboBinding.boundAtLabel': 'Bound at',
        'weiboBinding.avatarAlt': 'Weibo avatar',
        'weiboBinding.avatarFallback': 'Weibo',
        'weiboBinding.unknownName': 'No nickname returned',
        'weiboBinding.bind': 'Bind current Weibo account',
        'weiboBinding.rebind': 'Re-bind',
        'weiboBinding.unbind': 'Unbind',
        'weiboBinding.unbindConfirmTitle': 'Unbind Weibo Account',
        'weiboBinding.unbindConfirmDescription': 'Confirm unbind description',
        'weiboBinding.confirmUnbind': 'Confirm unbind',
        'weiboBinding.confirmTitle': 'Confirm Weibo Account Binding',
        'weiboBinding.confirmDescription': 'Confirm description',
        'weiboBinding.switchAccount': 'Go to weibo.com',
        'weiboBinding.cancel': 'Cancel',
        'weiboBinding.confirmBind': 'Confirm binding',
        'weiboBinding.bindSuccess': 'Weibo account bound',
        'weiboBinding.bindFailed': 'Failed to bind Weibo account',
        'weiboBinding.unbindSuccess': 'Weibo account unbound',
        'weiboBinding.unbindFailed': 'Failed to unbind Weibo account',
        'weiboBinding.subMissing': 'No Weibo login session was detected',
        'weiboBinding.accountChanged': 'The current Weibo account changed',
      }
      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: { children: ReactNode }) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children, ...props }: { children: ReactNode }) => (
    <div role="alertdialog" {...props}>
      {children}
    </div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

const mockedUserApis = userApis as jest.Mocked<typeof userApis>

describe('WeiboBindingSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser = {
      id: 1,
      user_name: 'tester',
      weibo_uid: '1234567890',
      weibo_screen_name: '微博用户',
      weibo_avatar_url: 'https://weibo.com/avatar.jpg',
      weibo_bound_at: '2026-06-03T00:00:00+00:00',
    }
  })

  it('requires confirmation before unbinding', async () => {
    mockedUserApis.unbindWeiboAccount.mockResolvedValue({
      bound: false,
      weibo_uid: null,
      weibo_screen_name: null,
      weibo_avatar_url: null,
      weibo_bound_at: null,
    })

    render(<WeiboBindingSettings />)

    fireEvent.click(screen.getByTestId('unbind-weibo-button'))

    expect(mockedUserApis.unbindWeiboAccount).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('confirm-weibo-unbind-button'))

    await waitFor(() => {
      expect(mockedUserApis.unbindWeiboAccount).toHaveBeenCalledTimes(1)
    })
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockToast).toHaveBeenCalledWith({ title: 'Weibo account unbound' })
  })

  it('closes stale preview dialog when confirmed uid changes', async () => {
    mockedUserApis.previewWeiboAccount.mockResolvedValue({
      weibo_uid: '1234567890',
      weibo_screen_name: '微博用户',
      weibo_avatar_url: null,
    })
    mockedUserApis.bindWeiboAccount.mockRejectedValue(
      new ApiError('changed', 409, 'weibo_uid_changed')
    )

    render(<WeiboBindingSettings />)

    fireEvent.click(screen.getByTestId('bind-weibo-button'))

    await waitFor(() => {
      expect(screen.getByTestId('weibo-binding-confirm-dialog')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('confirm-weibo-bind-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('weibo-binding-confirm-dialog')).not.toBeInTheDocument()
    })
    expect(mockToast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: 'The current Weibo account changed',
    })
  })
})
