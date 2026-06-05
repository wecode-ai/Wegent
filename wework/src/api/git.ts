import type { GitBranch, GitRepoInfo } from '@/types/api'
import type { HttpClient } from './http'

const REPOSITORY_FETCH_LIMIT = 5000

export function createGitApi(client: HttpClient) {
  return {
    listRepositories(): Promise<GitRepoInfo[]> {
      return client.get(`/git/repositories?limit=${REPOSITORY_FETCH_LIMIT}`)
    },
    listBranches(repo: GitRepoInfo): Promise<GitBranch[]> {
      const params = new URLSearchParams({
        git_repo: repo.git_repo,
        type: repo.type,
        git_domain: repo.git_domain,
      })
      return client.get(`/git/repositories/branches?${params.toString()}`)
    },
  }
}
