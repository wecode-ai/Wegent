const selector = (content, id) => `${content} [data-testid="${id}"]`

export async function openProjectTemplateConfiguration(control, content) {
  await control.command('clickWhenEnabled', selector(content, 'project-create-configure-template'))
  await control.command('waitFor', selector(content, 'project-create-template-configuration'), {
    visible: true,
  })
}

export async function confirmProjectTemplateConfiguration(control, content) {
  await control.command(
    'clickWhenEnabled',
    selector(content, 'project-create-template-configuration-apply')
  )
  await control.command('waitFor', selector(content, 'project-create-template-configuration'), {
    visible: false,
  })
}
