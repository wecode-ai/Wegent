// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import type {
  FormSubmissionRequest,
  FormSubmissionResponse,
  FormSubmissionStatus,
  FormCompletedPayload,
  FormErrorPayload,
} from '@/types/form'
import { formApis } from '@/apis/forms'
import { useSocket } from '@/contexts/SocketContext'

interface UseFormSubmissionOptions {
  onCompleted?: (payload: FormCompletedPayload) => void
  onError?: (payload: FormErrorPayload) => void
}

interface UseFormSubmissionReturn {
  submit: (request: FormSubmissionRequest) => Promise<FormSubmissionResponse>
  isSubmitting: boolean
  submissionId: string | null
  status: FormSubmissionStatus | null
  error: string | null
  reset: () => void
}

/**
 * Hook for submitting forms and tracking submission status via WebSocket.
 */
export function useFormSubmission(
  options: UseFormSubmissionOptions = {}
): UseFormSubmissionReturn {
  const { onCompleted, onError } = options

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submissionId, setSubmissionId] = useState<string | null>(null)
  const [status, setStatus] = useState<FormSubmissionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Get socket from context
  const { socket } = useSocket()

  // Listen to WebSocket events for form updates
  useEffect(() => {
    if (!socket || !submissionId) return

    const handleCompleted = (payload: FormCompletedPayload) => {
      if (payload.submission_id === submissionId) {
        setStatus('completed')
        setIsSubmitting(false)
        onCompleted?.(payload)
      }
    }

    const handleError = (payload: FormErrorPayload) => {
      if (payload.submission_id === submissionId) {
        setStatus('error')
        setError(payload.error)
        setIsSubmitting(false)
        onError?.(payload)
      }
    }

    socket.on('form:completed', handleCompleted)
    socket.on('form:error', handleError)

    return () => {
      socket.off('form:completed', handleCompleted)
      socket.off('form:error', handleError)
    }
  }, [socket, submissionId, onCompleted, onError])

  // Submit form
  const submit = useCallback(
    async (request: FormSubmissionRequest): Promise<FormSubmissionResponse> => {
      setIsSubmitting(true)
      setError(null)
      setStatus('pending')

      try {
        const response = await formApis.submit(request)
        setSubmissionId(response.submission_id)
        setStatus(response.status)

        if (response.status === 'error') {
          setError(response.message)
          setIsSubmitting(false)
        } else if (response.status === 'completed') {
          // Already completed synchronously
          setIsSubmitting(false)
        }
        // If 'processing', keep isSubmitting true until WebSocket event

        return response
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'
        setError(errorMessage)
        setStatus('error')
        setIsSubmitting(false)
        throw err
      }
    },
    []
  )

  // Reset state
  const reset = useCallback(() => {
    setIsSubmitting(false)
    setSubmissionId(null)
    setStatus(null)
    setError(null)
  }, [])

  return {
    submit,
    isSubmitting,
    submissionId,
    status,
    error,
    reset,
  }
}

export default useFormSubmission
