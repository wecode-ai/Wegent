// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics tracking service entry point.
 *
 * Usage:
 * 1. Initialize the tracker in your app's root layout:
 *    ```tsx
 *    useEffect(() => {
 *      analyticsTracker.init();
 *      return () => analyticsTracker.destroy();
 *    }, []);
 *    ```
 *
 * 2. Track page views with Next.js router:
 *    ```tsx
 *    const pathname = usePathname();
 *    useEffect(() => {
 *      analyticsTracker.reportPageView(pathname);
 *    }, [pathname]);
 *    ```
 *
 * 3. Add custom tracking IDs to elements:
 *    ```tsx
 *    <Button data-track-id="create_task_button">Create Task</Button>
 *    ```
 */

export { analyticsTracker } from './tracker'
export type {
  EventType,
  ErrorType,
  BaseEvent,
  ClickEvent,
  PageViewEvent,
  ErrorEvent,
  AnalyticsEvent,
  AnalyticsEventResponse,
  ClickEventData,
  ErrorEventData,
} from './types'
