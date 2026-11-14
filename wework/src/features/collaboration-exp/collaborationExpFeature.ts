export const COLLABORATION_EXPERIENCE_FLAG = 'collab.experience.v1'
export const COLLABORATION_EXP_PATH = '/collaboration-exp'
export const COLLABORATION_EXP_TAB_ID = 'fixed-collaboration-exp'

export function isCollaborationExpPath(contentRoute: string): boolean {
  return contentRoute.split('?', 1)[0] === COLLABORATION_EXP_PATH
}
