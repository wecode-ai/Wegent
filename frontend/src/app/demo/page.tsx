// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { UserProvider } from '@/features/common/UserContext'
import UserMenu from '@/features/layout/UserMenu'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Form, Input, Button } from 'antd'

export default function DemoPage() {
  return (
    <UserProvider>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      <div className="flex h-screen bg-base text-text-primary">
        {/* Main content area */}
        <div className="flex-1 flex flex-col ">
          {/* Demo content */}
          <div className="p-4">
            <h1 className="text-2xl font-bold">Demo Page</h1>
            <p>This is a demo page for experimenting with new components and layouts.</p>
            <Form layout="vertical" className="mt-4">
              <Form.Item label="Leader Bot Name">
                <Input.TextArea rows={4} placeholder="Enter details here" />
              </Form.Item>
              <Form.Item label="Bot Name1">
                <Input.TextArea rows={4} placeholder="Enter details here" />
              </Form.Item>
              <Form.Item label="Bot Name2">
                <Input.TextArea rows={4} placeholder="Enter details here" />
              </Form.Item>
              <Form.Item label="Bot Name3">
                <Input.TextArea rows={4} placeholder="Enter details here" />
              </Form.Item>
              <Form.Item>
                <Button type="primary">Submit</Button>
              </Form.Item>
            </Form>
          </div>
        </div>
      </div>
    </UserProvider>
  )
}