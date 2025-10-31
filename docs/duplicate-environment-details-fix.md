# 重复 environment_details 问题修复

## 问题描述

在 user 消息中出现了多个重复的 `<environment_details>` 块，导致上下文冗余和 token 浪费。

### 问题日志示例

```json
{
	"role": "user",
	"content": [
		{
			"type": "text",
			"text": "<task>\n...\n</task>"
		},
		{
			"type": "text",
			"text": "<environment_details>\n# VSCode Visible Files\n...\n</environment_details>"
		},
		{
			"type": "text",
			"text": "<environment_details>\n# VSCode Visible Files\n...\n</environment_details>"
		},
		{
			"type": "text",
			"text": "<environment_details>\n# VSCode Visible Files\n...\n</environment_details>"
		}
	]
}
```

## 问题根源

### 代码流程分析

1. **第1826-1827行**：从栈中获取 `currentUserContent` 和 `currentIncludeFileDetails`

    ```typescript
    const currentItem = stack.pop()!
    const currentUserContent = currentItem.userContent
    const currentIncludeFileDetails = currentItem.includeFileDetails
    ```

2. **第1905-1916行**：处理 `currentUserContent`，得到 `parsedUserContent`

    ```typescript
    const [parsedUserContent, needsRulesFileCheck] = await processKiloUserContentMentions({
    	context: this.getContext(),
    	userContent: currentUserContent,
    	// ...
    })
    ```

3. **第1926行**：获取环境详情

    ```typescript
    const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)
    ```

4. **第1930行**：将 `environmentDetails` 添加到 `parsedUserContent` 中

    ```typescript
    const finalUserContent = [...parsedUserContent, { type: "text" as const, text: environmentDetails }]
    ```

5. **第1932行**：将 `finalUserContent` 添加到 API 对话历史中

    ```typescript
    await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
    ```

6. **第2508-2512行**：当需要继续循环时，将 `userMessageContent` 推送到栈中
    ```typescript
    if (this.userMessageContent.length > 0) {
    	stack.push({
    		userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
    		includeFileDetails: false, // Subsequent iterations don't need file details
    	})
    }
    ```

### 问题链条

1. **首次迭代**：

    - `currentUserContent` = 初始任务内容（不含 environment_details）
    - 添加 environment_details → `finalUserContent`
    - 添加到 API 历史

2. **工具执行后**：

    - 工具结果被添加到 `userMessageContent`
    - `userMessageContent` 被推送到栈中（第2510行）

3. **第二次迭代**：
    - `currentUserContent` = `userMessageContent`（可能包含之前的 environment_details？）
    - **再次添加** environment_details → 重复！

### 深层问题

实际上，`userMessageContent` 本身不应该包含 environment_details，因为它只包含工具结果。但是，如果 `currentUserContent` 在某些情况下已经包含了 environment_details（比如从之前的迭代中遗留下来），那么就会出现重复。

**更可能的情况是**：`currentUserContent` 在某些边缘情况下可能已经包含了 environment_details 文本块，然后在第1930行又添加了一次。

## 解决方案

### 方案 1：在添加前检查是否已存在（推荐）

在第1930行之前，检查 `parsedUserContent` 中是否已经包含 environment_details：

```typescript
// 第1926行之后添加
const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)

// 检查 parsedUserContent 中是否已经包含 environment_details
const hasEnvironmentDetails = parsedUserContent.some(
	(block) => block.type === "text" && block.text.includes("<environment_details>"),
)

// 只有在不存在时才添加
const finalUserContent = hasEnvironmentDetails
	? parsedUserContent
	: [...parsedUserContent, { type: "text" as const, text: environmentDetails }]
```

### 方案 2：在推送到栈前过滤（备选）

在第2510行推送到栈之前，过滤掉 environment_details：

```typescript
if (this.userMessageContent.length > 0) {
	// 过滤掉 environment_details 块
	const filteredContent = this.userMessageContent.filter(
		(block) => !(block.type === "text" && block.text.includes("<environment_details>")),
	)

	stack.push({
		userContent: [...filteredContent],
		includeFileDetails: false,
	})
}
```

### 方案 3：使用标志位（最安全）

在 `StackItem` 中添加一个标志位，表示是否已经添加了 environment_details：

```typescript
interface StackItem {
	userContent: Anthropic.Messages.ContentBlockParam[]
	includeFileDetails: boolean
	hasEnvironmentDetails?: boolean // 新增标志位
}

// 第1930行修改为
const hasEnvDetails =
	currentItem.hasEnvironmentDetails ||
	parsedUserContent.some((block) => block.type === "text" && block.text.includes("<environment_details>"))

const finalUserContent = hasEnvDetails
	? parsedUserContent
	: [...parsedUserContent, { type: "text" as const, text: environmentDetails }]

// 第2510行修改为
stack.push({
	userContent: [...this.userMessageContent],
	includeFileDetails: false,
	hasEnvironmentDetails: true, // 标记已经添加过
})
```

## 推荐实施方案

**方案 1** 是最简单且最直接的解决方案，因为：

1. **最小侵入性**：只需要在一个地方添加检查
2. **向后兼容**：不改变现有的数据结构
3. **容错性强**：即使在其他地方有遗漏，也能防止重复

## 实施步骤

1. 在 `Task.ts` 第1926行之后添加检查逻辑
2. 测试以下场景：
    - 首次任务启动
    - 工具执行后的后续迭代
    - 从历史恢复任务
    - 多次工具调用的连续迭代

## 相关文件

- `src/core/task/Task.ts` - 第1926-1932行（修复位置）
- `src/core/task/Task.ts` - 第2508-2512行（栈推送位置）
- `src/core/environment/getEnvironmentDetails.ts` - 环境详情生成函数

## 测试验证

修复后，检查 API 对话历史中的 user 消息，确保：

1. 每个 user 消息只包含一个 `<environment_details>` 块
2. environment_details 始终位于消息内容的末尾
3. 在多次迭代中不会累积重复的 environment_details

## 注意事项

- 此修复只能防止未来的重复，无法修复已经保存的历史数据
- 如果历史数据已经包含重复的 environment_details，建议清理或重新开始任务
- 在实施修复后，监控日志以确保问题不再出现
