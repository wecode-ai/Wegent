const selector = (content, id) => `${content} [data-testid="${id}"]`

export async function openProjectTemplateConfiguration(control, content, options = {}) {
  await control.command(
    'clickWhenEnabled',
    selector(content, 'project-create-configure-template'),
    {
      ...options,
      visible: true,
    }
  )
  await control.command('waitFor', selector(content, 'project-create-template-configuration'), {
    ...options,
    visible: true,
  })
}

export async function confirmProjectTemplateConfiguration(control, content, options = {}) {
  await control.command(
    'clickWhenEnabled',
    selector(content, 'project-create-template-configuration-apply'),
    { ...options, visible: true }
  )
  await control.command('waitFor', selector(content, 'project-create-template-configuration'), {
    ...options,
    visible: false,
  })
}
