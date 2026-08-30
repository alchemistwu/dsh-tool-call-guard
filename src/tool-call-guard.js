/**
 * tool-call-guard — neutralize tool calls whose arguments are not valid JSON
 * before they reach the wire.
 *
 * Problem (observed in production: GLM-5.3-Flash via vLLM): a model can emit a
 * tool call with malformed `arguments` (unescaped inner quotes, truncated
 * JSON). OpenAI-compatible servers accept it on the streaming generation path
 * but validate strictly on the history-replay path, so the poisoned entry
 * persists in the harness log and every later request in that session fails:
 *
 *   400 "Assistant tool call function.arguments must be valid JSON."
 *
 * Strategy: intercept the `llm/stream` waterfall. For each assistant tool-call
 * block whose arguments do not parse as JSON:
 *
 *   1. The call is replaced (on the wire only) with a plain text block
 *      describing the omission, so the model can see its earlier call was
 *      malformed and re-issue a corrected one.
 *   2. Its matching tool-result message is re-expressed as an ordinary user
 *      message: "[Tool Result: <tool>] <text>". This follows the orphaned-
 *      tool-result re-expression pattern discussed upstream (deepseek-harness
 *      discussion #4668) and keeps the conversation protocol-balanced: no
 *      dangling tool_calls entry, no orphan role:"tool" message.
 *
 * Valid calls pass through untouched (one JSON.parse per block). The harness's
 * durable append-only log is never modified. Provider-agnostic, zero config.
 */

const name = 'tool-call-guard'
const inject = ['llm']

const applied = new WeakSet()

/** Flatten a tool-result content array to plain text for the user-message form. */
function flattenResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (b?.type === 'text') return b.text ?? ''
      return ''
    })
    .join('')
    .trim()
}

/** Collect ids of tool-call blocks in an assistant message whose arguments are invalid JSON. */
function invalidCalls(content) {
  const bad = []
  if (!Array.isArray(content)) return bad
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    try {
      JSON.parse(block.arguments)
    } catch {
      bad.push({ id: String(block.id), name: String(block.name ?? 'unknown') })
    }
  }
  return bad
}

export function apply(ctx) {
  if (applied.has(ctx)) return
  applied.add(ctx)

  ctx.on('llm/stream', (options, next) => {
    try {

      const messages = options?.messages
      if (!Array.isArray(messages) || messages.length === 0) return next(options)

      // Pass 1: find invalid calls per assistant message.
      const badByIndex = new Map() // message index -> Map(id -> name)
      const droppedIds = new Map() // id -> tool name (for result matching)
      messages.forEach((message, index) => {
        if (message?.role !== 'assistant') return
        const bad = invalidCalls(message.content)
        if (bad.length > 0) {
          badByIndex.set(index, new Map(bad.map((c) => [c.id, c.name])))
          for (const c of bad) droppedIds.set(c.id, c.name)
        }
      })
      if (droppedIds.size === 0) return next(options)

      // Pass 2: rewrite IN PLACE. cordis waterfall semantics: next() discards
      // its arguments — the dispatch closure is invoked with the ORIGINAL argv.
      // The only way an interceptor can change what the adapter receives is
      // mutating the argv object itself (options.messages is an array we can
      // splice).
      messages.forEach((message, index) => {
        // Re-express tool-result messages whose call was invalid.
        if (message?.role === 'user' && Array.isArray(message.content)) {
          const result = message.content.find((b) => b?.type === 'tool-result')
          if (result) {
            const callId = String(result.toolCallId ?? '')
            if (droppedIds.has(callId)) {
              const tool = droppedIds.get(callId)
              const text =
                `[Tool Result: ${tool}] ` +
                (flattenResultText(result.content) || '(no output)')
              message.content = [{ type: 'text', text }]
            }
          }
          return
        }

        // Replace invalid tool-call blocks with an honest record: what was
        // called, with exactly the arguments the model emitted, so the model
        // can see its own mistake and re-issue a corrected call. The raw text
        // is safe here — text blocks are plain strings on the wire, escaped
        // by the adapter's serializer; no JSON parsing is involved.
        if (message?.role !== 'assistant') return
        const bad = badByIndex.get(index)
        if (bad === undefined) return
        message.content = message.content.map((block) => {
          if (block?.type !== 'tool-call' || !bad.has(String(block.id))) {
            return block
          }
          return {
            type: 'text',
            text:
              `[A tool call to '${bad.get(String(block.id))}' was removed from history because its arguments were malformed JSON. ` +
              `Original arguments as emitted: ${String(block.arguments)}]`,
          }
        })
      })

      for (const [id, tool] of droppedIds) {
        ctx.logger.warn(
          `tool-call-guard: neutralized tool call ${id} (${tool}) — invalid JSON arguments replaced with an explanatory note on the wire`,
        )
      }
      return next()
    } catch (error) {
      // The guard must never break the request.
      ctx.logger.warn(`tool-call-guard: pass-through after error: ${String(error)}`)
      return next(options)
    }
  })

  ctx.logger.info('tool-call-guard: llm/stream interception active (invalid tool-call arguments are neutralized on the wire)')
}
