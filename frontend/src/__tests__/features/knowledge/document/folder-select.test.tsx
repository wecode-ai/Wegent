import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { FolderSelect } from '@/features/knowledge/document/components/FolderSelect'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const folderOptions = [
  { id: 7, name: 'Project', depth: 0 },
  { id: 42, name: 'Archive', depth: 1 },
]

describe('FolderSelect', () => {
  it('provides a default test ID and an associated visible label', () => {
    render(<FolderSelect folderId={7} folderOptions={folderOptions} />)

    const trigger = screen.getByTestId('folder-select-trigger')
    expect(screen.getByLabelText('document.folder.selectFolder')).toBe(trigger)
    expect(trigger).toHaveTextContent('Project')
  })

  it('preserves custom trigger IDs and unique label associations across instances', () => {
    render(
      <>
        <FolderSelect folderId={0} folderOptions={folderOptions} triggerTestId="first-folder" />
        <FolderSelect folderId={7} folderOptions={folderOptions} triggerTestId="second-folder" />
      </>
    )

    const first = screen.getByTestId('first-folder')
    const second = screen.getByTestId('second-folder')
    expect(first.id).not.toBe(second.id)
    expect(screen.getAllByLabelText('document.folder.selectFolder')).toEqual([first, second])
  })

  it('uses stable folder IDs for options and reports numeric folder selections', () => {
    const onFolderChange = jest.fn()
    render(
      <FolderSelect folderId={7} folderOptions={folderOptions} onFolderChange={onFolderChange} />
    )

    const trigger = screen.getByTestId('folder-select-trigger')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByTestId('folder-select-option-0')).toHaveTextContent(
      'document.folder.rootLevel'
    )
    expect(screen.getByTestId('folder-select-option-7')).toHaveTextContent('Project')
    fireEvent.click(screen.getByTestId('folder-select-option-42'))
    expect(onFolderChange).toHaveBeenLastCalledWith(42)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('folder-select-option-0'))
    expect(onFolderChange).toHaveBeenLastCalledWith(0)
  })

  it('keeps a disabled selector non-interactive', () => {
    render(<FolderSelect folderId={0} folderOptions={folderOptions} disabled />)

    expect(screen.getByTestId('folder-select-trigger')).toBeDisabled()
  })
})
