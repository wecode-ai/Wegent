import { cloudTodoIssueResourceKey } from './cloudTodoWorkspaceSupport'
import type { CloudLoopItem, CloudLoopItemAttachment } from '@/api/deliveries'
import type { createCloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
import { locateBoardItems } from './cloudTodoLocalBoard'
import { projectSpaceKey, projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
type Observation = CloudTodoWorkspaceObservation
export function createCloudTodoProjectResources(
  state: ReturnType<typeof createCloudTodoWorkspaceState>
) {
  let current: Observation | undefined
  let generation = 0
  const reads = new Map<string, { keys: readonly unknown[]; revision: number }>()
  const changed = (key: string, keys: readonly unknown[]) => {
    const previous = reads.get(key)
    if (
      previous &&
      previous.keys.length === keys.length &&
      keys.every((value, index) => Object.is(value, previous.keys[index]))
    )
      return null
    const revision = (previous?.revision ?? 0) + 1
    reads.set(key, { keys, revision })
    const epoch = generation
    return () => epoch === generation && reads.get(key)?.revision === revision
  }
  const localCatalog = (input: Observation) => {
    const valid = changed('catalog', [
      input.catalogApi,
      state.getSnapshot().localProjectsRefreshNonce,
    ])
    if (!valid || !input.catalogApi) return
    void input.catalogApi
      .listCloudProjects()
      .then(response => {
        if (valid())
          state.update({
            localProjectsError: null,
            localProjectSpaces: response.items.map(project => ({
              ...project,
              project_store: 'local',
              location: 'local',
            })),
          })
      })
      .catch(error => {
        console.error('[Wework project spaces] local list failed', error)
        if (valid())
          state.setLocalProjectsError(
            error instanceof Error ? error.message : '本地项目空间加载失败'
          )
      })
      .finally(() => {
        if (valid()) state.setLocalProjectsLoading(false)
      })
  }
  const describe = (input: Observation) => {
    const project = input.project
    const api = input.props.services.aitableApi
    const valid = changed('fields', [project, api])
    if (!valid || !project || project.task_provider !== 'dingtalk_aitable' || !api) return
    void api
      .describe(project.id)
      .then(description => {
        if (!valid()) return
        const mapping = project.provider_config.board_mapping
        const mappedStatus =
          typeof mapping === 'object' && mapping !== null
            ? (mapping as Record<string, unknown>).status_field_id
            : null
        const fallback =
          description.fields.find(field => field.id === mappedStatus) ??
          description.fields.find(field => /select|member|checkbox/i.test(field.type)) ??
          description.fields[0]
        state.setAitableFields(description.fields)
        state.setAitableGroupFieldId(previous =>
          description.fields.some(field => field.id === previous) ? previous : (fallback?.id ?? '')
        )
      })
      .catch(error => {
        if (valid())
          state.setBoardError(error instanceof Error ? error.message : '读取钉钉字段失败')
      })
  }
  const cloudBoard = (input: Observation) => {
    const project = input.project
    const snapshot = state.getSnapshot()
    const key = project ? projectSpaceKey(projectSpaceRef(project)) : null
    const services = input.props.services
    const valid = changed('cloudBoard', [
      key,
      project?.task_provider,
      snapshot.boardParentId,
      snapshot.boardRefreshNonce,
      input.cloud.commands,
      services.aitableApi,
      services.dwsApi,
    ])
    if (!valid || project?.location !== 'cloud') return
    const aitable = project.task_provider === 'dingtalk_aitable'
    const checkAuthentication = async () => {
      if (!aitable || !services.dwsApi) return false
      const status = await services.dwsApi.authStatus()
      if (!valid()) return true
      if (!status.authenticated || status.token_valid === false) {
        state.setDingtalkAuthPrompt(true)
        return true
      }
      return false
    }
    void (async () => {
      try {
        await checkAuthentication()
        if (!valid()) return
        if (aitable && services.aitableApi) await services.aitableApi.configureProject(project)
        if (!valid()) return
        await input.cloud.commands.loadProject(
          String(project.id),
          snapshot.boardRefreshNonce === 0 ? undefined : false,
          { isCurrent: valid, ...(snapshot.boardRefreshNonce ? { invalidate: true } : {}) }
        )
      } catch (error) {
        if (!valid()) return
        try {
          if (await checkAuthentication()) return
        } catch {
          /* Keep the original load failure when authentication lookup also fails. */
        }
        if (valid())
          state.setBoardError(error instanceof Error ? error.message : '云端协作数据加载失败')
      }
    })()
  }
  const cloudLoadState = (input: Observation) => {
    const project = input.project
    if (project?.location !== 'cloud') return
    const cloud = input.cloud.state
    const error = cloud.errorSource === 'load' ? cloud.error : null
    const valid = changed('cloudLoadState', [
      project,
      cloud.boardLoadRevision,
      cloud.project?.id,
      error,
      input.props.services.dwsApi,
    ])
    if (!valid) return
    if (!error && cloud.project?.id === String(project.id))
      state.update({ dingtalkAuthPrompt: false, boardError: null })
    else if (error) {
      if (project.task_provider === 'dingtalk_aitable' && input.props.services.dwsApi) {
        void input.props.services.dwsApi
          .authStatus()
          .then(status => {
            if (valid() && (!status.authenticated || status.token_valid === false))
              state.update({ dingtalkAuthPrompt: true, boardError: null })
          })
          .catch(() => undefined)
      } else state.setBoardError(error)
    }
  }
  const selectedDetail = (input: Observation) => {
    const selected = state.getSnapshot().selectedItem
    const project = input.itemProject
    const valid = changed('detail', [
      selected,
      project,
      input.itemApi,
      input.cloud.commands,
      input.cloudApi,
      input.detailLoadError,
    ])
    if (
      !valid ||
      !selected ||
      selected.detail_loaded !== false ||
      !project ||
      (project.location === 'cloud' ? !input.cloudApi : !input.itemApi)
    )
      return
    const request =
      project.location === 'cloud'
        ? input.cloud.commands.getIssue(selected.id).then(item => {
            if (!item) throw new Error('云端协作数据加载失败')
            return item as CloudLoopItem
          })
        : input.itemApi!.getLoopItem(selected.id)
    void request
      .then(item => {
        if (!valid()) return
        const located = { ...item, project_store: selected.project_store }
        state.setSelectedItem(previous => (previous?.id === selected.id ? located : previous))
        if (project.location === 'local')
          state.setItems(previous =>
            previous.map(candidate => (candidate.id === selected.id ? located : candidate))
          )
      })
      .catch(error => {
        if (valid())
          state.setBoardError(error instanceof Error ? error.message : input.detailLoadError)
      })
  }
  const selectedProjectItems = (input: Observation) => {
    const selected = state.getSnapshot().selectedItem
    const project = input.itemProject
    const valid = changed('detailItems', [
      selected,
      project,
      input.project,
      input.localApi,
      input.cloudApi,
      input.cloud.commands,
      input.cloud.state.projectItems,
    ])
    if (
      !valid ||
      !selected ||
      !project ||
      (input.project && sameProjectSpace(projectSpaceRef(project), projectSpaceRef(input.project)))
    )
      return
    if (project.location === 'cloud') {
      if (input.cloudApi && !input.cloud.state.projectItems[String(project.id)])
        void input.cloud.commands.loadProjectSnapshot(String(project.id))
    } else if (input.localApi) {
      void input.localApi
        .listLoopItems(selected.cloud_project_id)
        .then(result => {
          if (valid()) state.setDetailItems(locateBoardItems(result.items, project.project_store))
        })
        .catch(() => undefined)
    }
  }
  const searchProjects = (input: Observation) => {
    const open = state.getSnapshot().globalSearchOpen
    const valid = changed('search', [
      open,
      input.projects,
      input.localApi,
      input.cloud.commands,
      input.cloud.state.projectItems,
    ])
    if (!valid || !open) return
    void Promise.allSettled(
      input.projects.map(async project => {
        if (project.location === 'cloud') {
          if (!input.cloud.state.projectItems[String(project.id)])
            await input.cloud.commands.loadProjectSnapshot(String(project.id))
          return null
        }
        if (!input.localApi) return null
        const result = await input.localApi.listLoopItems(project.id)
        return { project, items: result.items }
      })
    ).then(results => {
      if (!valid()) return
      state.setLocalProjectItems(previous => {
        const next = { ...previous }
        for (const result of results)
          if (result.status === 'fulfilled' && result.value)
            next[projectSpaceKey(projectSpaceRef(result.value.project))] = result.value.items
        return next
      })
    })
  }
  const attachments = (input: Observation) => {
    const item = state.getSnapshot().selectedItem
    const project = input.itemProject
    const owner = cloudTodoIssueResourceKey(item, project, input.props.user.id)
    const valid = changed('attachments', [
      input.taskPanelOpen,
      item,
      project,
      input.cloudApi,
      input.itemApi,
    ])
    if (
      !valid ||
      !input.taskPanelOpen ||
      !item ||
      !project ||
      (project.location === 'cloud' ? !input.cloudApi : !input.itemApi)
    )
      return
    const request =
      project.location === 'cloud'
        ? input.cloudApi!.attachments.list(item.id).then(rows => rows as CloudLoopItemAttachment[])
        : input.itemApi!.listLoopItemAttachments(item.id)
    void request.then(
      rows => {
        if (valid())
          state.setIssueResourceAttachmentState({ owner, itemId: item.id, attachments: rows })
      },
      () => {
        if (valid())
          state.setIssueResourceAttachmentState({ owner, itemId: item.id, attachments: [] })
      }
    )
  }
  const members = (input: Observation) => {
    const project = input.project
    const valid = changed('members', [project, input.projectApi])
    if (!valid || project?.location !== 'local' || !input.projectApi) return
    const key = projectSpaceKey(projectSpaceRef(project))
    void input.projectApi
      .listCloudProjectMembers(project.id)
      .then(rows => {
        if (valid()) state.setLocalProjectMembers(previous => ({ ...previous, [key]: rows }))
      })
      .catch(error =>
        console.warn('[Wework project board] member refresh failed', {
          projectId: project.id,
          error,
        })
      )
  }
  return {
    observe(input: Observation) {
      current = input
      localCatalog(input)
      describe(input)
      cloudBoard(input)
      cloudLoadState(input)
      selectedDetail(input)
      selectedProjectItems(input)
      searchProjects(input)
      attachments(input)
      members(input)
    },
    stop() {
      generation++
      reads.clear()
      current = undefined
    },
    getObservation: () => current,
  }
}
