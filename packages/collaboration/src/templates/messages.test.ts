import { describe, expect, it } from 'vitest'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
import { templateFailureMessage, templateMessages } from './messages'

function httpError(status: number, detail: unknown) {
  return Object.assign(new Error(typeof detail === 'string' ? detail : 'Request rejected'), {
    status,
    detail,
  })
}

describe.each(['zh-CN', 'en'] as const)('template failures (%s)', locale => {
  it('keeps runtime configuration codes localized', () => {
    expect(
      templateFailureMessage(
        new TemplateConfigurationError('template_model_default_unavailable'),
        locale
      )
    ).toBe(templateMessages[locale].defaultModelRequired)
  })
  it('preserves the error category when a final refresh fails after creation', () => {
    const failure = new PartialTemplateApplyError(templateMessages[locale].partial, {
      cause: httpError(500, 'Internal error'),
    })
    const message = templateFailureMessage(failure, locale)
    expect(message).toContain('500')
    expect(message).toContain(templateMessages[locale].partial)
    expect(message).not.toMatch(/检查连接|Check your connection/)
  })
  it.each([401, 403, 409, 422, 500, 503])('does not call HTTP %s a connection failure', status => {
    const message = templateFailureMessage(httpError(status, 'Request rejected'), locale)
    expect(message).not.toMatch(/检查连接|Check your connection/)
    expect(message).toContain(String(status))
  })

  it('preserves actionable known member and stage failures without exposing arbitrary bodies', () => {
    const member = templateFailureMessage(
      httpError(422, 'Human is not available in this Project'),
      locale
    )
    expect(member).toMatch(/Developer/)
    const stage = templateFailureMessage(
      httpError(422, 'Collaboration group leader cannot execute a stage'),
      locale
    )
    expect(stage).toContain(templateMessages[locale].bindError)
    const privateBody = '<html>SQL password=secret internal traceback</html>'
    expect(templateFailureMessage(httpError(500, privateBody), locale)).not.toContain(privateBody)
    expect(templateFailureMessage(httpError(422, privateBody), locale)).not.toContain('secret')
  })

  it('distinguishes duplicate names from other conflicts', () => {
    const duplicate = templateFailureMessage(
      httpError(409, 'Collaboration group name already exists in this owner scope'),
      locale
    )
    expect(duplicate).toContain(templateMessages[locale].duplicateGroup)
    expect(templateFailureMessage(httpError(409, 'Cloud project changed'), locale)).not.toContain(
      templateMessages[locale].duplicateGroup
    )
  })

  it('identifies validation fields without rendering rejected inputs', () => {
    const message = templateFailureMessage(
      httpError(422, [
        {
          loc: ['body', 'stages', 0, 'assignee'],
          msg: 'secret',
          input: 'private configuration',
        },
      ]),
      locale
    )
    expect(message).toMatch(/阶段|stage/)
    expect(message).not.toMatch(/secret|private configuration/)
  })

  it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])(
    'reports the fetch transport failure: %s',
    message => {
      expect(templateFailureMessage(new TypeError(message), locale)).toMatch(
        /检查连接|Check your connection/
      )
    }
  )

  it('keeps unexpected programming errors neutral and trusted configuration errors actionable', () => {
    expect(
      templateFailureMessage(new TypeError('Cannot read properties of undefined'), locale)
    ).not.toMatch(/检查连接|Check your connection/)
    expect(templateFailureMessage(new Error('private traceback'), locale)).not.toContain('private')
    expect(
      templateFailureMessage(new TemplateConfigurationError('Choose a different owner'), locale)
    ).toBe('Choose a different owner')
  })
})
