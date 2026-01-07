// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { UserProvider } from '@/features/common/UserContext'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useForm } from 'react-hook-form'
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

export default function DemoPage() {
  const form = useForm({
    defaultValues: {
      leaderBot: '',
      bot1: '',
      bot2: '',
      bot3: '',
    },
  })

  const onSubmit = (data: Record<string, string>) => {
    console.log(data)
  }

  return (
    <UserProvider>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Main content area */}
        <div className="flex-1 flex flex-col ">
          {/* Demo content */}
          <div className="p-4">
            <h1 className="text-2xl font-bold">Demo Page</h1>
            <p>This is a demo page for experimenting with new components and layouts.</p>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
                <FormField
                  control={form.control}
                  name="leaderBot"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Leader Bot Name</FormLabel>
                      <FormControl>
                        <Textarea rows={4} placeholder="Enter details here" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bot1"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bot Name1</FormLabel>
                      <FormControl>
                        <Textarea rows={4} placeholder="Enter details here" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bot2"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bot Name2</FormLabel>
                      <FormControl>
                        <Textarea rows={4} placeholder="Enter details here" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bot3"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bot Name3</FormLabel>
                      <FormControl>
                        <Textarea rows={4} placeholder="Enter details here" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <Button type="submit">Submit</Button>
              </form>
            </Form>
          </div>
        </div>
      </div>
    </UserProvider>
  )
}
