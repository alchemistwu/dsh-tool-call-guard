# dsh-tool-call-guard

English | [中文](README.zh.md)

Neutralize tool calls with invalid JSON **arguments** before they reach the wire — so one malformed model generation cannot brick an entire session.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-5b50ed.svg)](https://github.com/deepseek-ai/deepseek-harness)

## Why

Some models occasionally emit a tool call whose `arguments` string is not valid JSON — most often unescaped inner quotes:

```json
{"queries": [""The Idiots" trailer youtube official"]}
```

Strict OpenAI-compatible servers (vLLM and friends) are **asymmetric about this**:

- **Streaming generation path** — lenient. The malformed call streams through, the harness persists it into the append-only session log, and the turn appears to succeed.
- **History-replay path** — strict. The next request replays the poisoned tool call, the server validates it, and rejects the **entire request**:

```
400 {"message": "Assistant tool call function.arguments must be valid JSON.",
     "type": "BadRequestError"}
```

From that moment, **every subsequent request in the session fails**. The session is bricked until its log is surgically repaired by hand. The same failure class exists across ecosystems ([openai-agents-python #2061](https://github.com/openai/openai-agents-python/issues/2061), [vLLM #41122](https://github.com/vllm-project/vllm/issues/41122)).

## What it does

Intercepts the harness's `llm/stream` waterfall. For every assistant tool-call block whose `arguments` fail `JSON.parse`:

1. **The call becomes an honest text record** (wire-only) — the model sees exactly what it emitted and can re-issue a corrected call:
   ```
   [A tool call to 'web_search' was removed from history because its arguments
   were malformed JSON. Original arguments as emitted: {"queries": [""The Idiots" …]}]
   ```
2. **The matching tool result is re-expressed as a plain user message** — result content is preserved, and the conversation stays protocol-balanced (no dangling `tool_calls` entry, no orphan `role:"tool"` reply — each of those is itself a 400 on strict servers):
   ```
   [Tool Result: web_search] 10 results about The Idiots
   ```

The orphaned-result-as-user-message pattern follows the upstream serializer discussion ([deepseek-harness #4668](https://github.com/deepseek-ai/deepseek-harness/discussions/4668)).

### Properties

- **Zero overhead for clean history** — one `JSON.parse` per tool-call block; messages array passes through with object identity when nothing is wrong.
- **Append-only log respected** — the harness's durable session log is never rewritten; neutralization is applied per-request on the wire only.
- **Provider-agnostic** — sits on `llm/stream`, so every adapter (deepseek, community, custom) is covered.
- **Fail-open** — if the guard itself errors, the original request passes through untouched.
- **Zero configuration** — install and restart.

## Install

```sh
dsh plugin --profile web add github:alchemistwu/dsh-tool-call-guard
# or desktop:
dsh plugin --profile desktop add github:alchemistwu/dsh-tool-call-guard
```

The plugin has no bundle patch of its own; add the insert entry to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tool-call-guard
      name: dsh-tool-call-guard
```

Restart your `dsh web` / DSH Desktop host, then start a new session.

## Observed in production

First observed with `zai-org/GLM-5.3-Flash` served by vLLM 0.27 (`--enable-auto-tool-choice`): one `web_search` call with unescaped quotes around a film title streamed through fine, was persisted, and permanently poisoned the session with `400 … arguments must be valid JSON` on every later turn. This plugin keeps that session alive: the poisoned entry is re-expressed per-request, the session continues working, and the model sees its own mistake in context.

## License

MIT
