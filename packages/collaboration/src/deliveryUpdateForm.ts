import type { WorkspaceDeliveryUpdate } from './ports/SharedWorkspaceApi'

/** Stage all files with their metadata so a save can commit atomically. */
export function deliveryUpdateForm(input: WorkspaceDeliveryUpdate): FormData {
  const form = new FormData()
  form.set(
    'metadata',
    JSON.stringify({
      ...input,
      files: input.files.map(({ relative_path, file }) => ({
        relative_path,
        display_name: file.name,
        content_type: file.type || null,
      })),
    }),
  )
  input.files.forEach(({ file }, index) =>
    form.set(`file_${index}`, file, file.name),
  )
  return form
}
