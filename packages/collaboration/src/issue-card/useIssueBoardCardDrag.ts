import { useContext, useMemo } from 'react'
import { ProjectBoardCardContext } from '../project-board/projectBoardCardContext'
import { useProjectBoardCardTransfer } from '../project-board/projectBoardTransferContext'

export function useIssueBoardCardDrag(id: string, enabled: boolean) {
  const column = useContext(ProjectBoardCardContext)
  const columnKey = column?.columnKey
  const groupBy = column?.groupBy
  const data = useMemo(
    () => ({ columnKey, groupBy, itemId: id }),
    [columnKey, groupBy, id],
  )
  const key = JSON.stringify([groupBy, columnKey, id])
  return useProjectBoardCardTransfer(key, data, enabled)
}
