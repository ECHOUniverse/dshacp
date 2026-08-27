import type { ElicitationSchema } from '@agentclientprotocol/sdk'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** ACP form payload derived from one or more user-questions items. */
export interface MappedElicitationForm {
  message: string
  schema: ElicitationSchema
}

/**
 * Map DSH user-questions items to an ACP elicitation form schema.
 *
 * The ACP client renders `message` once at the top and each field by its JSON
 * Schema `title` (not the internal `qN` key). Selectable questions therefore
 * omit field `description` so the message body is not repeated under `q0`.
 */
export const mapUserQuestionsToElicitation = (
  questions: AskUserQuestionItem[],
): MappedElicitationForm => {
  const properties: ElicitationSchema['properties'] = {}
  const required: string[] = []
  const messageParts: string[] = []

  for (const [index, question] of questions.entries()) {
    const key = `q${index}`
    const labels = question.options?.map((option) => option.label) ?? []
    const messageBody = question.detail ?? question.question
    messageParts.push(messageBody)

    const fieldTitle = question.header
    const fieldDescription = labels.length > 0
      ? undefined
      : messageBody

    const base: { title?: string; description?: string } = {}
    if (fieldTitle !== undefined) {
      base.title = fieldTitle
    }
    if (fieldDescription !== undefined) {
      base.description = fieldDescription
    }

    if (question.multiSelect === true) {
      properties[key] = { type: 'array', ...base, items: { type: 'string', enum: labels } }
    } else if (labels.length > 0) {
      properties[key] = { type: 'string', ...base, enum: labels }
    } else {
      properties[key] = { type: 'string', ...base }
    }
    required.push(key)
  }

  return {
    message: messageParts.join('\n\n'),
    schema: { type: 'object', properties, required },
  }
}
