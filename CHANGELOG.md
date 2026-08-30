# Changelog

## 0.1.1

- Document the read-only `llm/stream` waterfall discovery (deep-frozen request argv; `next()` discards arguments) — verified with runtime probes.
- Add the adapter-serializer sanitization reference implementation (`examples/`), the layer where neutralization actually works.
- Add the test suite covering the production poison, multi-call messages, and protocol-balance invariants.
- Keep the waterfall listener as a detector (observability) only.

## 0.1.0

- Initial release: neutralize tool calls with invalid JSON arguments on the wire before they brick a session against strict OpenAI-compatible servers (vLLM et al).
- First observed in production with GLM-5.3-Flash on vLLM 0.27: unescaped inner quotes in `web_search` arguments streamed through, persisted into the session log, and made every later request in that session fail with `400 "Assistant tool call function.arguments must be valid JSON"`.
