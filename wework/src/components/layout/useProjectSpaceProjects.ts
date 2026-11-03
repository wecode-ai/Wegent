import { useEffect, useMemo, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'

export function useProjectSpaceProjects(active: boolean, apis: ProjectSpaceApi[]) {
  const [projectsByApi, setProjectsByApi] = useState(new Map<ProjectSpaceApi, CloudProject[]>())

  useEffect(() => {
    if (!active) return
    let current = true
    const publish = (source: ProjectSpaceApi, projects: CloudProject[]) => {
      if (!current) return
      setProjectsByApi(
        previous =>
          new Map(apis.map(api => [api, api === source ? projects : (previous.get(api) ?? [])]))
      )
    }
    for (const api of apis) {
      void Promise.resolve()
        .then(() => api.listCloudProjects())
        .then(result => publish(api, result.items))
        .catch(() => publish(api, []))
    }
    return () => {
      current = false
    }
  }, [active, apis])

  return useMemo(() => {
    const projects = apis.flatMap(api => projectsByApi.get(api) ?? [])
    return projects.filter(
      (project, index) =>
        projects.findIndex(
          other => other.id === project.id && other.project_store === project.project_store
        ) === index
    )
  }, [apis, projectsByApi])
}
