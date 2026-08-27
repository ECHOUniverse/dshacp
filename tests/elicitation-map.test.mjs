/**
 * Unit checks for user-questions → ACP elicitation mapping.
 * Run: node tests/elicitation-map.test.mjs
 */
import assert from 'node:assert/strict'

const { mapUserQuestionsToElicitation } = await import('../lib/elicitation-map.js')

const autotitleConfirm = mapUserQuestionsToElicitation([{
  id: 'autotitle-confirm',
  header: '会话标题',
  question: '会话标题',
  detail: '生成的标题：【Question】 PBS批量提交与取消VASP计算任务\n请选择操作，或在下方输入自定义标题后提交',
  options: [
    { label: '接受此标题' },
    { label: '重新生成' },
    { label: '取消' },
  ],
}])

assert.equal(
  autotitleConfirm.message,
  '生成的标题：【Question】 PBS批量提交与取消VASP计算任务\n请选择操作，或在下方输入自定义标题后提交',
)
assert.equal(autotitleConfirm.schema.properties.q0.title, '会话标题')
assert.equal(autotitleConfirm.schema.properties.q0.description, undefined)
assert.notEqual(autotitleConfirm.message, autotitleConfirm.schema.properties.q0.title)

const legacyConfirm = mapUserQuestionsToElicitation([{
  id: 'autotitle-confirm',
  header: '会话标题',
  question: '生成的标题：【Question】 PBS批量提交与取消VASP计算任务\n请选择操作，或在下方输入自定义标题后提交',
  options: [
    { label: '接受此标题' },
    { label: '重新生成' },
    { label: '取消' },
  ],
}])

assert.equal(
  legacyConfirm.message,
  '生成的标题：【Question】 PBS批量提交与取消VASP计算任务\n请选择操作，或在下方输入自定义标题后提交',
)
assert.equal(legacyConfirm.schema.properties.q0.description, undefined)
assert.equal(legacyConfirm.schema.properties.q0.title, '会话标题')

const genericAsk = mapUserQuestionsToElicitation([{
  id: 'q1',
  question: 'Continue?',
  options: [{ label: 'yes' }, { label: 'no' }],
}])

assert.match(genericAsk.message, /Continue/i)
assert.equal(genericAsk.schema.properties.q0.description, undefined)

console.log('elicitation-map.test.mjs: all assertions passed')
