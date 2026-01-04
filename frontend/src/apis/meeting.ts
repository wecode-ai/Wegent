// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Meeting Booking API Service
 *
 * This module provides functions to interact with the remote meeting booking service.
 * The API endpoint is configured via environment variable NEXT_PUBLIC_MEETING_API_ENDPOINT.
 */

import type { CreateMeetingRequest, MeetingBookingResponse } from '@/types/api';

/**
 * Get the meeting API endpoint from environment or use a default mock endpoint.
 */
function getMeetingApiEndpoint(): string {
  // Try to get from environment variable
  const endpoint = process.env.NEXT_PUBLIC_MEETING_API_ENDPOINT;
  if (endpoint) {
    return endpoint;
  }

  // Default to mock endpoint (returns simulated success)
  return '/api/meeting/mock';
}

/**
 * Create a new meeting booking.
 *
 * This function calls the remote meeting booking service API directly.
 * The API endpoint is configured via NEXT_PUBLIC_MEETING_API_ENDPOINT environment variable.
 *
 * @param request - The meeting booking request
 * @returns Promise resolving to the booking response
 */
export async function createMeeting(
  request: CreateMeetingRequest
): Promise<MeetingBookingResponse> {
  const endpoint = getMeetingApiEndpoint();

  // If using mock endpoint, return mock success response
  if (endpoint === '/api/meeting/mock') {
    return mockCreateMeeting(request);
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Add additional headers as needed (e.g., authentication)
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error:
          errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return await response.json();
  } catch (error) {
    console.error('[MeetingAPI] createMeeting failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error occurred',
    };
  }
}

/**
 * Mock implementation for development/testing.
 * This simulates a successful meeting booking response.
 */
async function mockCreateMeeting(
  request: CreateMeetingRequest
): Promise<MeetingBookingResponse> {
  // Simulate a network delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // Generate a mock meeting ID
  const meetingId = `MTG-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    meetingId,
    message: `Meeting "${request.title}" has been successfully booked.`,
  };
}

/**
 * Cancel an existing meeting.
 *
 * @param meetingId - The ID of the meeting to cancel
 * @returns Promise resolving to the cancellation response
 */
export async function cancelMeeting(meetingId: string): Promise<MeetingBookingResponse> {
  const baseEndpoint = getMeetingApiEndpoint();

  // If using mock endpoint, return mock success
  if (baseEndpoint === '/api/meeting/mock') {
    return {
      success: true,
      message: `Meeting ${meetingId} has been cancelled.`,
    };
  }

  try {
    const response = await fetch(`${baseEndpoint}/${meetingId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error:
          errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return await response.json();
  } catch (error) {
    console.error('[MeetingAPI] cancelMeeting failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error occurred',
    };
  }
}
