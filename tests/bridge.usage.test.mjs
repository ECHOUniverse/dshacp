// Usage-accounting unit tests (no model, no process). `accumulateUsage`'s two
// pure seams: `usedTokens` (the context-occupancy total behind `usage_update` —
// a SNAPSHOT of the latest step, `used = input + cacheRead + (output −
// reasoning)`; cumulative summing across steps would re-count the cached
// prefix on every request and overflow) and `estimateReasoningTokens` (the
// dshacp-only pi-ai / opencode-go fallback, whose adapter `dsh-llm-pi-ai`
// drops `reasoningTokens`, so the thinking text in the assistant message
// content is estimated with the token-meter `CHARS_PER_TOKEN = 4` heuristic).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateReasoningTokens, usedTokens } from '../lib/bridge.js'

test('usedTokens reports input + cacheRead + non-reasoning output', () => {
  // Plain turn without reasoning: output counts in full.
  assert.equal(usedTokens(100, 0, 50, 0), 150)
  assert.equal(usedTokens(100, 40, 50, 0), 190)
  // Turn with reasoning: output minus reasoning (deepseek-official path, exact).
  assert.equal(usedTokens(100, 40, 50, 30), 160)
  // cacheWrite exclusion is structural here: `usedTokens` has no cache-write
  // parameter, so that dimension is out of the context-occupancy seam by
  // construction (see the helper's JSDoc); nothing to assert at this seam.
})

test('usedTokens never reports negative for a pathological reasoning over-report', () => {
  assert.equal(usedTokens(0, 0, 10, 100), 0)
  assert.equal(usedTokens(100, 0, 10, 100), 100)
})

test('estimateReasoningTokens returns 0 for absent or reasoning-free content', () => {
  assert.equal(estimateReasoningTokens(undefined), 0)
  assert.equal(estimateReasoningTokens([]), 0)
  assert.equal(estimateReasoningTokens([{ type: 'text', text: 'visible output, no thinking' }]), 0)
  assert.equal(estimateReasoningTokens([{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }]), 0)
})

test('estimateReasoningTokens sums reasoning text at ceil(len / 4) per block', () => {
  // 16 chars / 4 = 4 tokens exactly.
  assert.equal(estimateReasoningTokens([{ type: 'reasoning', text: 'abcdefghijklmnop' }]), 4)
  // 17 chars → ceil(17 / 4) = 5.
  assert.equal(estimateReasoningTokens([{ type: 'reasoning', text: 'abcdefghijklmnopq' }]), 5)
  // Reasoning text is typically dense Chinese thinking: no assumption on the
  // estimate's accuracy, only that empty thinking never contributes.
  assert.equal(estimateReasoningTokens([{ type: 'reasoning', text: '' }]), 0)
})

test('estimateReasoningTokens ignores non-reasoning blocks while summing multiple reasoning blocks', () => {
  assert.equal(estimateReasoningTokens([
    { type: 'reasoning', text: 'aaaa' }, // 1 token
    { type: 'text', text: 'output' }, // ignored
    { type: 'reasoning', text: 'bbbbbbbbbbbb' }, // 3 tokens
    { type: 'reasoning', text: 'cc' }, // ceil(2/4) = 1 token
  ]), 5)
})