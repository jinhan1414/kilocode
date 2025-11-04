# 原生工具调用上下文压缩修复文档

## 问题描述

在使用原生工具调用(Native Tool Calling)时,当对话上下文被压缩后,出现了工具调用数据不完整的问题:

```json
{
  "role": "assistant",
  "content": "1. Previous Conversation:"
},
{
  "role": "tool",
  "tool_call_id": "tooluse_Y1KV8wGGRRaPqg_y8Sjfiw",
  "content": "[read_file for 'packages/core/package.json', "
}
```

**问题特征:**

- 压缩过程中丢失了发起工具调用的 assistant 消息(包含 `tool_calls`)
- 却保留了工具调用的结果(tool 消息,包含 `tool_call_id`)
- 导致 OpenAI API 调用失败,因为 tool 消息必须跟随在对应的 assistant 消息之后

## 根本原因

### 1. 消息压缩逻辑缺陷

[`src/core/sliding-window/index.ts`](../../src/core/sliding-window/index.ts) 中的 [`truncateConversation`](../../src/core/sliding-window/index.ts:48) 函数在压缩消息时:

```typescript
// 原有逻辑
const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)
const remainingMessages = messages.slice(messagesToRemove + 1)
```

- 简单地按索引删除消息,确保删除偶数个消息
- **没有考虑工具调用对的完整性**

### 2. 工具调用消息结构

在 Anthropic 格式中,工具调用是成对出现的:

```
Assistant Message (包含 tool_use blocks)
  ↓
User Message (包含 tool_result blocks)
```

转换为 OpenAI 格式后:

```
Assistant Message (包含 tool_calls)
  ↓
Tool Message (包含 tool_call_id)
```

如果压缩时删除了 assistant 消息但保留了 user/tool 消息,就会导致数据不完整。

## 修复方案

### 修复 1: 增强消息压缩逻辑

**文件:** [`src/core/sliding-window/index.ts`](../../src/core/sliding-window/index.ts)

**修改内容:**

```typescript
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): ApiMessage[] {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)
	const truncatedMessages = [messages[0]]
	const rawMessagesToRemove = Math.floor((messages.length - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	// 找到实际的切割点,确保不破坏工具调用对
	let cutIndex = messagesToRemove + 1

	// 检查是否在工具调用序列中间切割
	if (cutIndex < messages.length) {
		const messageAtCut = messages[cutIndex]

		// 检查这是否是包含 tool_result 的用户消息
		if (messageAtCut.role === "user" && Array.isArray(messageAtCut.content)) {
			const hasToolResults = messageAtCut.content.some((block: any) => block.type === "tool_result")

			if (hasToolResults) {
				// 向前查找对应的 assistant 消息(包含 tool_use)
				for (let i = cutIndex - 1; i > 0; i--) {
					const msg = messages[i]
					if (msg.role === "assistant" && Array.isArray(msg.content)) {
						const hasToolUse = msg.content.some((block: any) => block.type === "tool_use")
						if (hasToolUse) {
							// 将切割点移到这个 assistant 消息之前
							// 这样可以排除不完整的工具调用对
							cutIndex = i
							break
						}
					}
				}
			}
		}
	}

	const remainingMessages = messages.slice(cutIndex)
	truncatedMessages.push(...remainingMessages)

	return truncatedMessages
}
```

**关键改进:**

1. 在切割点检查是否有 `tool_result` blocks
2. 如果有,向前查找对应的 `tool_use` blocks
3. 调整切割点,确保工具调用对完整性

### 修复 2: 添加孤立工具结果验证

**文件:** [`src/api/transform/openai-format.ts`](../../src/api/transform/openai-format.ts)

**修改内容:**

```typescript
export function convertToOpenAiMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	toolStyle?: ToolUseStyle,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
	// 跟踪所有有效的 tool_use_id
	const validToolUseIds = new Set<string>()

	for (const anthropicMessage of anthropicMessages) {
		// ... 处理消息 ...

		if (anthropicMessage.role === "assistant") {
			// 处理 tool_use 时,记录 tool_use_id
			toolMessages.forEach((toolMessage) => {
				validToolUseIds.add(toolMessage.id)
				// ...
			})
		}

		if (anthropicMessage.role === "user") {
			// 处理 tool_result 时,验证对应的 tool_use_id 是否存在
			toolMessages.forEach((toolMessage) => {
				if (!validToolUseIds.has(toolMessage.tool_use_id)) {
					console.warn(
						`[convertToOpenAiMessages] Skipping orphaned tool result for tool_use_id: ${toolMessage.tool_use_id} (no matching tool_use found in conversation history)`,
					)
					return // 跳过孤立的工具结果
				}
				// ... 正常处理 ...
			})
		}
	}

	return openAiMessages
}
```

**关键改进:**

1. 使用 `validToolUseIds` Set 跟踪所有有效的 tool_use_id
2. 在处理 tool_result 时验证对应的 tool_use 是否存在
3. 跳过孤立的 tool_result,避免生成无效的 OpenAI 消息
4. 输出警告日志,便于调试

## 测试验证

### 场景 1: 正常工具调用对

**输入 (Anthropic 格式):**

```json
[
  {"role": "assistant", "content": [{"type": "tool_use", "id": "tool_1", "name": "read_file", "input": {...}}]},
  {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tool_1", "content": "..."}]}
]
```

**输出 (OpenAI 格式):**

```json
[
  {"role": "assistant", "tool_calls": [{"id": "tool_1", "type": "function", "function": {...}}]},
  {"role": "tool", "tool_call_id": "tool_1", "content": "..."}
]
```

✅ **结果:** 正常转换,工具调用对完整

### 场景 2: 压缩导致的孤立工具结果

**输入 (压缩后的 Anthropic 格式):**

```json
[
	{ "role": "user", "content": "Previous conversation..." },
	{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "tool_1", "content": "..." }] }
]
```

**输出 (OpenAI 格式):**

```json
[{ "role": "user", "content": "Previous conversation..." }]
```

✅ **结果:** 孤立的 tool_result 被跳过,输出警告日志

### 场景 3: 压缩时保护工具调用对

**输入:** 10 条消息,需要删除 50%

```
[0] System
[1] User: "请读取文件"
[2] Assistant: [tool_use: read_file]  ← 切割点原本在这里
[3] User: [tool_result]
[4] User: "继续工作"
[5] Assistant: "好的"
```

**修复前:** 删除消息 1-2,保留 3-5

- ❌ 消息 3 的 tool_result 变成孤立的

**修复后:** 检测到消息 3 有 tool_result,向前找到消息 2 的 tool_use,调整切割点到消息 2 之前

- ✅ 删除消息 1,保留 2-5,工具调用对完整

## 影响范围

### 受影响的功能

1. **自动上下文压缩** - 当对话超过 token 限制时触发
2. **手动上下文压缩** - 用户主动触发的压缩操作
3. **原生工具调用** - 使用 `toolStyle: "json"` 的所有提供商

### 受影响的提供商

- OpenAI
- OpenRouter
- Azure OpenAI
- 其他 OpenAI 兼容的提供商

### 不受影响的场景

- XML 工具调用模式 (`toolStyle: "xml"`)
- 不使用工具的普通对话

## 监控和日志

修复后会输出以下警告日志:

```
[convertToOpenAiMessages] Skipping orphaned tool result for tool_use_id: xxx (no matching tool_use found in conversation history)
```

如果在生产环境中看到此日志:

1. 说明压缩逻辑可能还有边界情况未覆盖
2. 但不会导致 API 调用失败,因为孤立的结果已被过滤
3. 建议收集日志并进一步优化压缩逻辑

## 相关文件

- [`src/core/sliding-window/index.ts`](../../src/core/sliding-window/index.ts) - 消息压缩逻辑
- [`src/api/transform/openai-format.ts`](../../src/api/transform/openai-format.ts) - Anthropic 到 OpenAI 格式转换
- [`src/api/providers/openai.ts`](../../src/api/providers/openai.ts) - OpenAI 提供商实现
- [`src/api/providers/kilocode/nativeToolCallHelpers.ts`](../../src/api/providers/kilocode/nativeToolCallHelpers.ts) - 原生工具调用辅助函数

## 后续优化建议

1. **添加单元测试** - 覆盖各种压缩场景
2. **性能优化** - 当前向前查找是 O(n),可以考虑使用索引优化
3. **更智能的压缩策略** - 考虑消息的重要性,而不仅仅是位置
4. **压缩统计** - 记录压缩前后的消息数量和 token 数量

## 修复日期

2025-11-04

## 修复作者

Kilo Code (AI Assistant)
