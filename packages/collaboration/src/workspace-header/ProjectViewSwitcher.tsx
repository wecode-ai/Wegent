import { TabsList, TabsRoot, TabsTab } from '../controls/Tabs'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import { FlatProjectViewSwitcher } from './FlatProjectViewSwitcher'
import { ProjectViewLabel } from './ProjectViewLabel'
import { ProjectViewMenu } from './ProjectViewMenu'
import { projectViewMessages } from './projectViewMessages'
import {
  buildProjectViewNavigation,
  createProjectViewSelectionMemory,
  resolveGroupedProjectView,
  type CollaborationProjectView,
  type CollaborationProjectViewOption,
  type ProjectViewSelectionMemory,
} from './projectViewNavigation'

export type * from './projectViewNavigation'

export interface ProjectViewSwitcherProps<
  View extends CollaborationProjectView = CollaborationProjectView,
> {
  ariaLabel?: string
  compact: boolean
  options: CollaborationProjectViewOption<View>[]
  value: View
  compactIcon?: ReactNode
  containerRef?: Ref<HTMLElement>
  locale?: keyof typeof projectViewMessages
  selectionMemory?: ProjectViewSelectionMemory
  selectionKey?: string
  onChange(view: View): void
}

export function ProjectViewSwitcher<View extends CollaborationProjectView>(
  props: ProjectViewSwitcherProps<View>
) {
  const groups = buildProjectViewNavigation(props.options)
  return groups.length ? (
    <GroupedProjectViewSwitcher {...props} />
  ) : (
    <FlatProjectViewSwitcher {...props} />
  )
}

function GroupedProjectViewSwitcher<View extends CollaborationProjectView>({
  ariaLabel,
  compact,
  containerRef,
  locale = 'zh-CN',
  onChange,
  options,
  selectionKey = 'default',
  selectionMemory,
  value,
}: ProjectViewSwitcherProps<View>) {
  const [localMemory] = useState(createProjectViewSelectionMemory)
  const memory = selectionMemory ?? localMemory
  const messages = projectViewMessages[locale]
  const groups = buildProjectViewNavigation(options)
  const primaryLabel = groups.map(group => messages[group.id]).join(' / ')
  const resolvedView = resolveGroupedProjectView(options, value)
  const selectedGroup =
    groups.find(group =>
      group.entries.some(
        entry =>
          entry.option.id === resolvedView ||
          entry.segments?.some(segment => segment.id === resolvedView)
      )
    ) ?? groups[0]
  const selectedEntry =
    selectedGroup.entries.find(
      entry =>
        entry.option.id === resolvedView ||
        entry.segments?.some(segment => segment.id === resolvedView)
    ) ?? selectedGroup.entries[0]

  const remembersPlan = selectedGroup.id === 'plan' && resolvedView === value
  const remembersTimeline = selectedEntry.id === 'timeline'
  const subscribeSelection = useCallback(
    (listener: () => void) =>
      memory.subscribe(
        selectionKey,
        listener,
        remembersPlan
          ? { planView: value, timelineView: remembersTimeline ? value : undefined }
          : undefined
      ),
    [memory, selectionKey, remembersPlan, remembersTimeline, value]
  )
  const readSelection = useCallback(() => memory.get(selectionKey), [memory, selectionKey])
  const rememberedSelection = useSyncExternalStore(subscribeSelection, readSelection, readSelection)

  const targetView = (entry: typeof selectedEntry) => {
    if (entry.segments?.some(segment => segment.id === resolvedView)) return resolvedView as View
    const timeline = rememberedSelection?.timelineView
    return entry.segments?.find(segment => segment.id === timeline)?.id ?? entry.option.id
  }
  const selectGroup = (group: typeof selectedGroup) => {
    if (group.id === selectedGroup.id) return
    const remembered = group.id === 'plan' ? rememberedSelection?.planView : undefined
    const available = group.entries.flatMap(entry => entry.segments ?? [entry.option])
    onChange(available.find(option => option.id === remembered)?.id ?? group.entries[0].option.id)
  }
  const secondary = selectedGroup.entries.map(entry => ({
    ...entry.option,
    id: targetView(entry),
    label: entry.id === 'timeline' ? messages.timeline : entry.option.label,
    testId: entry.id === 'timeline' ? 'collaboration-sub-timeline' : entry.option.testId,
    // Timeline aliases belong to the original segment, never its parent entry.
    oldTestIdAliases: entry.id === 'timeline' ? undefined : entry.option.oldTestIdAliases,
  }))

  return (
    <nav
      ref={containerRef}
      aria-label={ariaLabel ?? primaryLabel}
      className="project-view-switcher electron-titlebar-interactive-region"
      data-testid="project-view-switcher"
      data-compact={compact}
    >
      <TabsRoot
        value={selectedGroup.id}
        onValueChange={next => {
          const group = groups.find(group => group.id === next)
          if (group) selectGroup(group)
        }}
        render={<div className="contents" />}
      >
        <TabsList className="project-view-switcher-primary" aria-label={primaryLabel}>
          {groups.map(group => (
            <TabsTab
              value={group.id}
              key={group.id}
              type="button"
              className="project-view-switcher-tab"
              data-testid={
                group.id === 'work'
                  ? group.entries[0].option.testId
                  : `collaboration-tab-${group.id}`
              }
              aria-current={group.id === selectedGroup.id ? 'page' : undefined}
            >
              {group.id === 'work' ? (
                <ProjectViewLabel
                  option={{ ...group.entries[0].option, label: messages.work }}
                  selected={group.id === selectedGroup.id}
                />
              ) : (
                messages[group.id]
              )}
            </TabsTab>
          ))}
        </TabsList>
      </TabsRoot>
      {selectedGroup.id !== 'work' && (
        <div
          className="project-view-switcher-secondary"
          data-testid="collaboration-project-secondary"
        >
          {compact ? (
            <ProjectViewMenu
              label={
                selectedEntry.id === 'timeline' ? messages.timeline : selectedEntry.option.label
              }
              options={secondary}
              value={targetView(selectedEntry)}
              onChange={onChange}
            />
          ) : (
            <TabsRoot
              value={value}
              onValueChange={next => {
                if (next) onChange(next)
              }}
              render={<div className="contents" />}
            >
              <TabsList
                className="project-view-switcher-tabs"
                aria-label={messages[selectedGroup.id]}
              >
                {secondary.map((option, index) => {
                  const selected = selectedEntry.id === selectedGroup.entries[index].id
                  return (
                    <TabsTab
                      value={option.id}
                      key={option.id}
                      type="button"
                      className="project-view-switcher-tab project-view-switcher-subtab"
                      data-testid={option.testId}
                      aria-current={selected ? 'page' : undefined}
                    >
                      <ProjectViewLabel option={option} selected={selected} />
                    </TabsTab>
                  )
                })}
              </TabsList>
            </TabsRoot>
          )}
          {selectedEntry.segments && (
            <div
              className="project-view-switcher-segments"
              role="group"
              aria-label={messages.timeline}
            >
              {selectedEntry.segments.map(option => (
                <ControlButton
                  variant="unstyled"
                  key={option.id}
                  type="button"
                  data-testid={option.testId}
                  aria-pressed={option.id === resolvedView}
                  onClick={() => onChange(option.id)}
                >
                  <ProjectViewLabel option={option} selected={option.id === resolvedView} />
                </ControlButton>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  )
}
