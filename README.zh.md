# dsh-tool-call-guard

中文 | [English](README.md)

在 tool call 的 **arguments** 到达 wire 之前，把其中 JSON 不合法的调用中性化——避免一次模型的畸形输出毁掉整个 session。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-5b50ed.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-tool-call-guard.svg)](https://www.npmjs.com/package/dsh-tool-call-guard)
[![tests](https://img.shields.io/badge/tests-9%20passed-brightgreen.svg)](#tests)

```sh
dsh plugin add dsh-tool-call-guard
```

## 为什么需要它

部分模型偶尔会生成 `arguments` 不是合法 JSON 的 tool call——最常见的是内部引号未转义：

```json
{"queries": [""The Idiots" 预告片 youtube 官方"]}
```

严格的 OpenAI 兼容服务端（vLLM 等）对此**是双重标准**：

- **流式生成路径**——宽松。畸形调用流出来、被 harness 持久化进追加式 session 日志，当轮看起来一切正常。
- **历史回放路径**——严格。下一个请求回放这条毒化 tool call，服务端校验后拒绝**整个请求**：

```
400 {"message": "Assistant tool call function.arguments must be valid JSON.",
     "type": "BadRequestError"}
```

从此该 session **每次请求都会失败**，除非手工修复日志。同类问题在各生态都存在（[openai-agents-python #2061](https://github.com/openai/openai-agents-python/issues/2061)、[vLLM #41122](https://github.com/vllm-project/vllm/issues/41122)）。

## 它做什么

**消毒跑在 adapter 的消息序列化层**（各 adapter 把 harness 消息转成 wire 格式的地方），对每个请求应用两条规则：

⚠️ **为什么不在 `llm/stream` waterfall 上做？** 我们最初就挂在那里，实测**行不通**：harness 在派发前对整个请求（含 messages）deepFreeze，且 cordis waterfall 的 `next()` **丢弃传给它的参数**——dispatch 闭包永远拿到原始 argv；严格模式 ES module 对冻结对象赋值会 throw。这个 waterfall 实际是**只读的**，文档没有写明（我们用运行时探针验证的）。因此插件在 waterfall 上只做**探测器**（发现非法 arguments 时打 warn），真正中性化在 adapter 序列化层完成。对每个 `arguments` 过不了 `JSON.parse` 的 assistant tool-call 块：

1. **调用变成一条诚实的文本记录**（仅 wire 层）——模型能看到自己当时发出的原文，可以重新发起正确的调用：
   ```
   [A tool call to 'web_search' was removed from history because its arguments
   were malformed JSON. Original arguments as emitted: {"queries": [""The Idiots" …]}]
   ```
2. **配对的工具结果改写为普通用户消息**——结果内容保留，且会话保持协议平衡（不留悬挂 `tool_calls`，也不留孤儿 `role:"tool"`——这两者在严格服务端各自都是 400）：
   ```
   [Tool Result: web_search] 10 results about The Idiots
   ```

孤儿结果转用户消息的写法沿用上游 serializer 讨论（[deepseek-harness #4668](https://github.com/deepseek-ai/deepseek-harness/discussions/4668)）。

### 特性

- **干净历史零开销**——每个 tool-call 块一次 `JSON.parse`；无问题时不碰任何对象。
- **尊重追加式日志**——从不改写持久化 session 日志，中性化只在每次请求的 wire 层动态生效。
- **Provider 无关**——挂在 `llm/stream`，覆盖所有适配器。
- **失败放行**——guard 自身出错时原样透传请求。
- **零配置**——装上重启即生效。

## 安装

```sh
dsh plugin --profile web add dsh-tool-call-guard
# 或 desktop：
dsh plugin --profile desktop add dsh-tool-call-guard
```

或从 GitHub 安装：`dsh plugin add github:alchemistwu/dsh-tool-call-guard`。

包内声明了 `dsh.bundle` patch，安装即自动注册。重启 `dsh web` / DSH Desktop 后开新 session 生效。

## 生产实测

首发场景：vLLM 0.27（`--enable-auto-tool-choice`）部署的 `zai-org/GLM-5.3-Flash`，一次 `web_search` 调用里电影名引号未转义——流式正常、被持久化、之后该 session 每轮 400。装上本插件后 session 复活：毒条目在每次请求中被改写为诚实记录，模型在上下文里能看到自己当时的错误。

## 许可

MIT
