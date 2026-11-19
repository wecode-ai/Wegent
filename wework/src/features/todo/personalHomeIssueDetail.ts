import { mergeIssueReadConfirmation } from '@wegent/collaboration'
import type {
  CollaborationIssue,
  CollaborationIssueDetailRenderContext,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'

type Detail = Pick<
  CollaborationIssueDetailRenderContext,
  'issue' | 'allIssues' | 'assignments' | 'taskBindings'
>
interface Snapshot {
  detail?: Detail
  failed: boolean
}
interface Observer {
  notify(): void
  publish(issue: WorkspaceMyWorkItem): void
  summary: WorkspaceMyWorkItem
}

/** An authorized detail session owns reads, edits and read receipts independently. */
export class PersonalHomeIssueDetail {
  private snapshot: Snapshot = { failed: false }
  private observers = new Set<Observer>()
  private generation = 0
  private version: string | undefined
  private pending = false
  private interrupted = false
  private confirmed: CollaborationIssue | undefined

  private readonly api: SharedWorkspaceApi
  private readonly issueId: string
  private readonly projectId: string
  readonly projectStore: CollaborationProject['project_store']

  constructor(
    api: SharedWorkspaceApi,
    issueId: string,
    projectId: string,
    projectStore: CollaborationProject['project_store']
  ) {
    this.api = api
    this.issueId = issueId
    this.projectId = projectId
    this.projectStore = projectStore
  }

  getSnapshot = () => this.snapshot

  subscribe(observer: Observer, version: string) {
    this.observers.add(observer)
    if (version !== this.version || this.interrupted) {
      this.version = version
      this.interrupted = false
      void this.reload()
    }
    return () => {
      this.observers.delete(observer)
      if (!this.observers.size && this.pending) {
        const generation = this.generation
        // Commit-time callback replacement keeps the same pending read.
        queueMicrotask(() => {
          if (this.observers.size || generation !== this.generation || !this.pending) return
          this.generation += 1
          this.interrupted = true
          this.pending = false
        })
      }
    }
  }

  private notify() {
    this.observers.forEach(observer => observer.notify())
  }

  private publish(issue: CollaborationIssue, refresh = false) {
    this.observers.forEach(observer => {
      const summary = observer.summary
      if (!refresh || issue.title !== summary.title || issue.version !== summary.version)
        observer.publish({ ...summary, ...issue })
    })
  }

  reload = async () => {
    if (!this.observers.size) return
    const generation = ++this.generation
    this.pending = true
    this.snapshot = { ...this.snapshot, failed: false }
    this.notify()
    const current = () => generation === this.generation && this.observers.size > 0
    try {
      const item = await this.api.issues.get(this.issueId)
      if (!current()) return
      if (String(item.cloud_project_id) !== this.projectId)
        throw new Error('Issue project identity changed')
      const [allIssues, assignments, taskBindings] = await Promise.all([
        this.api.issues.list(this.projectId),
        this.api.assignments?.list(this.issueId) ?? Promise.resolve([]),
        this.api.taskBindings?.list(this.issueId, this.projectId) ?? Promise.resolve([]),
      ])
      if (!current()) return
      const issue = this.confirmed ? mergeIssueReadConfirmation(item, this.confirmed) : item
      this.snapshot = { detail: { issue, allIssues, assignments, taskBindings }, failed: false }
      this.pending = false
      this.publish(issue, true)
      this.notify()
    } catch {
      if (!current()) return
      this.pending = false
      this.snapshot = { ...this.snapshot, failed: true }
      this.notify()
    }
  }

  save = (issue: CollaborationIssue) => {
    if (!this.observers.size || !this.snapshot.detail) return
    this.generation += 1
    this.pending = false
    this.snapshot = { ...this.snapshot, detail: { ...this.snapshot.detail, issue } }
    this.publish(issue)
    this.notify()
  }

  confirmRead = (updated: CollaborationIssue) => {
    if (!this.observers.size || !this.snapshot.detail) return
    const issue = mergeIssueReadConfirmation(this.snapshot.detail.issue, updated)
    this.confirmed = issue
    this.snapshot = { ...this.snapshot, detail: { ...this.snapshot.detail, issue } }
    this.publish(issue)
    this.notify()
  }
}
