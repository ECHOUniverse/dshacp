// Pure schema tests for the background-settle gate config — no model, no
// process. Verifies the field default and constant that drive the prompt
// settlement gate (docs/prompt-settlement-background-work.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS } from '../lib/bridge.js'

test('backgroundSettleTimeoutMs defaults to the 30-minute cap constant', () => {
  assert.equal(Config.dict.backgroundSettleTimeoutMs?.meta?.default, 30 * 60 * 1000)
  assert.equal(Config.dict.backgroundSettleTimeoutMs?.meta?.default, DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS)
})

test('the existing config surface is unchanged', () => {
  for (const field of ['provider', 'model', 'approvalTimeoutMs', 'elicitationTimeoutMs', 'hybridFileWrites', 'backgroundSettleTimeoutMs']) {
    assert.ok(field in Config.dict, `still configures ${field}`)
  }
})
