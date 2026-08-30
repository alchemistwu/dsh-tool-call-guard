/**
 * Adapter-serializer reference implementation — the layer where tool-call
 * neutralization actually works.
 *
 * Why this file exists: the `llm/stream` waterfall is read-only (the request
 * is deep-frozen before dispatch and the waterfall's `next()` discards its
 * arguments — see README). The one place every request's messages are
 * necessarily copied into fresh wire objects is the adapter's serializer.
 * Drop this into your OpenAI-compatible adapter's serializeMessage to make
 * one malformed model generation unable to brick a session.
 *
 * The two rules, applied per request:
 *  1. An assistant tool-call block whose `arguments` fail JSON.parse is
 *     emitted as an honest text record (model sees its own output and can
 *     retry) instead of a tool_calls entry.
 *  2. The matching tool result is emitted as a plain user message
 *     ("[Tool Result: <tool>] …") — an orphan role:"tool" reply is itself
 *     rejected by strict servers.
 */

// Reset at the start of each request (assistant messages serialize before
// their tool results, so the ids are known by the time results are reached).
export const invalidToolCallIds = new Set()
export const invalidToolCallNames = new Map()

export function resetGuardState() {
  invalidToolCallIds.clear()
  invalidToolCallNames.clear()
}

/** Serialize one harness assistant message to OpenAI wire format, guarded. */
export function serializeAssistantMessageGuarded(message, flattenText) {
  const out = { role: 'assistant' }
  const blocks = Array.isArray(message.content) ? message.content : []
  const text = flattenText(blocks.filter((b) => b?.type !== 'tool-call'))
  if (text) out.content = text

  const calls = blocks.filter((b) => b?.type === 'tool-call')
  const validCalls = []
  for (const b of calls) {
    const args = String(b.arguments ?? '{}')
    try {
      JSON.parse(args)
      validCalls.push(b)
    } catch {
      invalidToolCallIds.add(String(b.id))
      invalidToolCallNames.set(String(b.id), String(b.name ?? 'unknown'))
      const note =
        out.content && typeof out.content === 'string' ? out.content + '\n' : ''
      out.content =
        note +
        `[A tool call to '${String(b.name ?? 'unknown')}' was removed from history because its arguments were malformed JSON. Original arguments as emitted: ${args}]`
    }
  }
  if (validCalls.length > 0) {
    out.tool_calls = validCalls.map((b, i) => ({
      id: b.id ?? `call_${i}`,
      type: 'function',
      function: { name: b.name, arguments: b.arguments ?? '{}' },
    }))
  }
  return out
}

/** Serialize one harness tool-result message to wire format, guarded. */
export function serializeToolResultGuarded(toolResult, flattenText) {
  const callId = String(toolResult.toolCallId ?? '')
  if (invalidToolCallIds.has(callId)) {
    const tool = invalidToolCallNames.get(callId) ?? 'unknown'
    const text = flattenText(toolResult.content) || '(no output)'
    return { role: 'user', content: `[Tool Result: ${tool}] ${text}` }
  }
  return {
    role: 'tool',
    tool_call_id: toolResult.toolCallId ?? '',
    content: flattenText(toolResult.content),
  }
}
