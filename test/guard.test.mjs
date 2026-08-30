/**
 * Tests for dsh-tool-call-guard: the serializer-layer reference rules and
 * the detector's invariants, replayed against the real production poison.
 *
 * Run: node test/guard.test.mjs
 */

import assert from 'node:assert/strict'
import {
  invalidToolCallIds,
  invalidToolCallNames,
  resetGuardState,
  serializeAssistantMessageGuarded,
  serializeToolResultGuarded,
} from '../examples/adapter-sanitize.ts' 

const flattenText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text ?? '' : ''))
          .join('')
      : ''

/** The exact malformed arguments that bricked a production session. */
const POISON =
  '{"queries": [""The Idiots" Szumowska 2026 trailer youtube youtu.be official TIFF"]}'

let passed = 0
function test(name, fn) {
  resetGuardState()
  fn()
  passed++
  console.log(`  ok ${name}`)
}

// --- Rule 1: invalid call becomes an honest text record -------------------
test('invalid call serialized as text, not tool_calls', () => {
  const wire = serializeAssistantMessageGuarded(
    { content: [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: POISON }] },
    flattenText,
  )
  assert.equal(wire.tool_calls, undefined)
  assert.match(wire.content, /removed from history because its arguments were malformed JSON/)
  assert.match(wire.content, /Original arguments as emitted: /)
  assert.ok(wire.content.includes('The Idiots'))
  assert.ok(invalidToolCallIds.has('c1'))
})

test('valid call passes through untouched', () => {
  const wire = serializeAssistantMessageGuarded(
    { content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"ls"}' }] },
    flattenText,
  )
  assert.equal(wire.tool_calls.length, 1)
  assert.equal(wire.tool_calls[0].function.arguments, '{"command":"ls"}')
  assert.equal(invalidToolCallIds.size, 0)
})

test('mixed message: good call kept, bad call recorded', () => {
  const wire = serializeAssistantMessageGuarded(
    {
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool-call', id: 'g1', name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'tool-call', id: 'b1', name: 'web_search', arguments: POISON },
      ],
    },
    flattenText,
  )
  assert.equal(wire.tool_calls.length, 1)
  assert.equal(wire.tool_calls[0].id, 'g1')
  assert.match(wire.content, /Let me search\./)
  assert.match(wire.content, /removed from history/)
})

// --- Rule 2: matching result re-expressed as user message -----------------
test('result of invalid call re-expressed as user text', () => {
  serializeAssistantMessageGuarded(
    { content: [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: POISON }] },
    flattenText,
  )
  const wire = serializeToolResultGuarded(
    { toolCallId: 'c1', content: [{ type: 'text', text: '10 results' }] },
    flattenText,
  )
  assert.equal(wire.role, 'user')
  assert.match(wire.content, /^\[Tool Result: web_search\] 10 results$/)
  assert.equal(wire.tool_call_id, undefined)
})

test('result of valid call stays role:tool', () => {
  const wire = serializeToolResultGuarded(
    { toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] },
    flattenText,
  )
  assert.equal(wire.role, 'tool')
  assert.equal(wire.tool_call_id, 'c2')
})

// --- Protocol-balance invariants (what strict servers check) ---------------
test('wire never carries an invalid-arguments tool_call', () => {
  const wire = serializeAssistantMessageGuarded(
    { content: [{ type: 'tool-call', id: 'x', name: 'web_search', arguments: POISON }] },
    flattenText,
  )
  const calls = wire.tool_calls ?? []
  for (const c of calls) {
    JSON.parse(c.function.arguments) // must not throw
  }
})

test('wire never carries an orphan role:tool message', () => {
  // simulate a whole request: assistant(bad) + result(bad) + assistant(text)
  const request = [
    serializeAssistantMessageGuarded(
      { content: [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: POISON }] },
      flattenText,
    ),
    serializeToolResultGuarded(
      { toolCallId: 'c1', content: [{ type: 'text', text: '10 results' }] },
      flattenText,
    ),
    serializeAssistantMessageGuarded(
      { content: [{ type: 'text', text: 'Here is the trailer.' }] },
      flattenText,
    ),
  ]
  const toolMsgs = request.filter((m) => m.role === 'tool')
  for (const t of toolMsgs) {
    const paired = request.some((a) =>
      (a.tool_calls ?? []).some((c) => c.id === t.tool_call_id),
    )
    assert.ok(paired, `tool message ${t.tool_call_id} has no paired call`)
  }
})

// --- Detector: empty/degenerate inputs -------------------------------------
test('degenerate messages do not throw', () => {
  const wire = serializeAssistantMessageGuarded({ content: null }, flattenText)
  assert.equal(wire.role, 'assistant')
  assert.equal(wire.tool_calls, undefined)
})

test('guard state resets between requests', () => {
  serializeAssistantMessageGuarded(
    { content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: POISON }] },
    flattenText,
  )
  assert.equal(invalidToolCallIds.size, 1)
  resetGuardState()
  assert.equal(invalidToolCallIds.size, 0)
  // a new request's valid result must NOT be re-expressed from stale state
  const wire = serializeToolResultGuarded(
    { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    flattenText,
  )
  assert.equal(wire.role, 'tool')
})

console.log(`\n${passed} tests passed`)
