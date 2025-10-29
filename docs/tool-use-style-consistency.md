# 工具调用格式一致性问题与修复

## 问题概述

工作区切换后，历史请求中的助手消息中的工具调用信息变为 XML 格式，导致 LLM 在处理混合格式时产生困惑。

## 技术背景

### ToolUseStyle 类型

系统支持两种工具调用格式：

- **`xml`**: 使用 XML 标签格式，如 `<tool_name><param>value</param></tool_name>`
- **`json`**: 使用 OpenAI 原生的 `tool_calls` JSON 格式

### 格式决策逻辑

`getActiveToolUseStyle()` 函数（位于 `packages/types/src/kilocode/native-function-calling.ts`）根据以下规则决定使用哪种格式：

1. 如果 provider 不在 `nativeFunctionCallingProviders` 列表中 → 返回 `"xml"`
2. 如果用户显式设置了 `settings.toolStyle` → 返回用户设置
3. 如果模型名称包含 `claude-haiku-4.5` 等关键词 → 返回 `"json"`
4. 默认 → 返回 `"xml"`

## 问题根源

### 问题链条

1. **历史消息转换**：`resumeTaskFromHistory()` 方法（Task.ts 第 1401-1436 行）在恢复任务时，会将所有历史的 `tool_use` 和 `tool_result` 块无条件转换为 XML 文本格式

2. **工作区切换触发**：根据 `workspace-switching-analysis.md`，工作区切换时会取消当前任务并重新加载，触发 `resumeTaskFromHistory()`

3. **格式不一致**：

    - 历史消息被强制转换为 XML 文本格式
    - 但当前的 `toolStyle` 可能是 `"json"`
    - `convertToOpenAiMessages()` 函数根据 `toolStyle` 转换消息：
        - `toolStyle === "xml"` → 将 `tool_use` 转换为 XML 文本
        - `toolStyle === "json"` → 将 `tool_use` 转换为 OpenAI `tool_calls` 格式

4. **结果**：历史消息是 XML 文本，新消息是 JSON 格式，LLM 看到混合格式产生困惑

### 深层问题

**即使修复了 `resumeTaskFromHistory` 方法，问题仍然可能存在**，因为：

1. **持久化问题**：如果历史消息在之前的某个时刻已经被转换为 XML 文本格式并保存到磁盘（`api_conversation_history.json`），那么即使修复了代码，恢复时读取的仍然是 XML 文本格式的消息

2. **无法识别**：一旦 `tool_use` 块被转换为 `type: "text"` 的文本块，`convertToOpenAiMessages` 函数就无法再将其识别为工具调用，只能当作普通文本处理

3. **格式混乱**：在同一个对话历史中，可能同时存在：
    - 旧的 XML 文本格式的工具调用（已保存到磁盘）
    - 新的 `tool_use` 块格式的工具调用（修复后生成）
    - 导致 LLM 看到不一致的格式

### 原始代码问题

```typescript
// Task.ts - resumeTaskFromHistory() 方法
const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
	if (Array.isArray(message.content)) {
		const newContent = message.content.map((block) => {
			if (block.type === "tool_use") {
				// ❌ 无条件转换为 XML 格式
				const inputAsXml = Object.entries(block.input as Record<string, string>)
					.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
					.join("\n")
				return {
					type: "text",
					text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
				}
			}
			// ...
		})
	}
})
```

## 解决方案

### 修复逻辑

在 `resumeTaskFromHistory()` 方法中，根据当前的 `toolStyle` 决定如何处理历史消息：

- **`toolStyle === "xml"`**：转换为 XML 文本格式（保持原有逻辑）
- **`toolStyle === "json"`**：保留原始 `tool_use` 和 `tool_result` 块，让 `convertToOpenAiMessages()` 在后续处理时转换为 OpenAI 格式

### 解决方案的局限性

**此修复只能防止未来的问题，无法修复已经损坏的历史数据**：

1. **对新任务有效**：从修复后开始的新任务，其历史消息会正确保存为 `tool_use` 块格式

2. **对旧任务无效**：如果任务的历史消息已经被保存为 XML 文本格式，修复代码无法将其还原为 `tool_use` 块

3. **需要清理历史**：对于已经出现问题的任务，可能需要：
    - 删除该任务的历史记录重新开始
    - 或者手动编辑 `api_conversation_history.json` 文件，将 XML 文本转换回 `tool_use` 块格式（非常复杂且容易出错）

### 修复代码

```typescript
// Task.ts - resumeTaskFromHistory() 方法
// 获取当前的 toolStyle
const currentToolStyle = getActiveToolUseStyle(this.apiConfiguration)

const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
	if (Array.isArray(message.content)) {
		const newContent = message.content.map((block) => {
			if (block.type === "tool_use") {
				// ✅ 根据 toolStyle 决定是否转换
				if (currentToolStyle === "xml") {
					// 转换为 XML 文本格式
					const inputAsXml = Object.entries(block.input as Record<string, string>)
						.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
						.join("\n")
					return {
						type: "text",
						text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
					}
				} else {
					// 保留原始格式，由 convertToOpenAiMessages 处理
					return block
				}
			} else if (block.type === "tool_result") {
				// ✅ 同样根据 toolStyle 决定
				if (currentToolStyle === "xml") {
					// 转换为文本格式
					const contentAsTextBlocks = Array.isArray(block.content)
						? block.content.filter((item) => item.type === "text")
						: [{ type: "text", text: block.content }]
					const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
					const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
					return {
						type: "text",
						text: `[${toolName} Result]\n\n${textContent}`,
					}
				} else {
					// 保留原始格式
					return block
				}
			}
			return block
		})
		return { ...message, content: newContent }
	}
	return message
})
```

## 消息转换流程

### XML 格式流程

```
历史 tool_use 块
    ↓ (resumeTaskFromHistory)
XML 文本块
    ↓ (convertToOpenAiMessages, toolStyle="xml")
OpenAI 消息（文本内容为 XML）
    ↓
发送给 LLM
```

### JSON 格式流程

```
历史 tool_use 块
    ↓ (resumeTaskFromHistory, 保持不变)
tool_use 块
    ↓ (convertToOpenAiMessages, toolStyle="json")
OpenAI 消息（tool_calls 格式）
    ↓
发送给 LLM
```

## 相关文件

- `src/core/task/Task.ts` - `resumeTaskFromHistory()` 方法（修复位置）
- `packages/types/src/kilocode/native-function-calling.ts` - `getActiveToolUseStyle()` 函数
- `src/api/transform/openai-format.ts` - `convertToOpenAiMessages()` 函数
- `docs/workspace-switching-analysis.md` - 工作区切换分析文档

## 测试场景

1. **XML 格式恢复**：使用不支持原生函数调用的 provider，切换工作区后恢复任务，验证历史消息为 XML 格式
2. **JSON 格式恢复**：使用 OpenAI/KiloCode provider，切换工作区后恢复任务，验证历史消息保持 tool_use 块格式
3. **格式一致性**：验证恢复后的对话中，所有消息使用相同的工具调用格式

## 注意事项

- 此修复确保了历史消息格式与当前 `toolStyle` 设置的一致性
- 不影响新任务的创建，只影响任务恢复流程
- 兼容旧版本的历史数据（v2.0 之前使用原生 tool_use 块的任务）
- **重要**：如果问题仍然存在，说明历史数据已经损坏，建议重新开始任务

## 根本解决方案

要彻底解决这个问题，需要：

1. **统一格式**：在整个系统中统一使用一种格式（建议使用 `tool_use` 块格式）
2. **迁移工具**：提供数据迁移工具，将已保存的 XML 文本格式转换回 `tool_use` 块格式
3. **版本控制**：在历史数据中添加版本标记，以便识别和处理不同格式的数据
