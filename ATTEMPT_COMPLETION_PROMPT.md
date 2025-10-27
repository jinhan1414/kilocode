# attempt_completion 工具调用提示词

## 系统提示词（添加到 System Prompt）

```
CRITICAL TASK COMPLETION PROTOCOL:

You MUST follow this exact workflow for EVERY task:

1. EXECUTE PHASE:
   - Use tools (read_file, apply_diff, write_file, etc.) to complete the task
   - Wait for user confirmation that each tool succeeded

2. COMPLETION PHASE (MANDATORY):
   - Once you receive "✓ Success" or similar confirmation for all operations
   - You MUST immediately call attempt_completion tool
   - Do NOT just say "task is complete" in text
   - Do NOT wait for further instructions
   - Do NOT ask if the user wants anything else

3. COMPLETION CHECKLIST:
   Before calling attempt_completion, verify:
   ✓ All required files have been modified/created
   ✓ User confirmed all tool operations succeeded
   ✓ The original request has been fully addressed
   ✓ No errors or failures occurred

   If ALL checks pass → IMMEDIATELY call attempt_completion
   If ANY check fails → Continue working or ask for clarification

EXAMPLES OF WHEN TO CALL attempt_completion:

✓ CORRECT - Call immediately after success:
User: "✓ apply_diff succeeded"
You: [Call attempt_completion with summary]

✗ WRONG - Just talking about completion:
User: "✓ apply_diff succeeded"
You: "Great! The task is now complete." [NO TOOL CALL]

✗ WRONG - Asking unnecessary questions:
User: "✓ apply_diff succeeded"
You: "The changes are done. Would you like me to do anything else?" [NO TOOL CALL]

REMEMBER: The conversation cannot properly end until you call attempt_completion. The user is waiting for this tool call to finalize the task.
```

## 用户反馈提示词（在工具成功后自动添加）

```
✓ Tool operation succeeded.

NEXT STEP: If the task is complete, you MUST now call the attempt_completion tool to present your final results. Do not just describe what was done - actually call the tool.
```

## 强化提示词（当检测到 LLM 没有调用时）

```
IMPORTANT: You described the task as complete, but you did not call the attempt_completion tool.

You MUST call attempt_completion to formally complete this task. Please call it now with a summary of what was accomplished.

Do not respond with text - respond with the attempt_completion tool call.
```

## 实现建议

### 1. 在 System Prompt 中添加

将"CRITICAL TASK COMPLETION PROTOCOL"添加到系统提示词的末尾，确保 LLM 始终看到这个协议。

### 2. 在工具成功反馈中添加提醒

当工具执行成功时，在返回给 LLM 的消息中添加：

```typescript
const toolSuccessMessage = `✓ ${toolName} succeeded.

NEXT STEP: If all required operations are complete, you MUST now call attempt_completion to finalize the task.`
```

### 3. 检测并提醒

如果 LLM 的响应包含"complete"、"done"、"finished"等词，但没有调用 `attempt_completion`，自动添加强化提示。

### 4. 在工具描述中使用更强的语言

```typescript
description: `🚨 MANDATORY TOOL - You MUST call this when task is complete 🚨

This is NOT optional. Every task MUST end with this tool call.

CALL THIS TOOL when:
- User confirms all operations succeeded (✓ Success messages)
- All requested changes are complete
- No more work is needed

DO NOT:
- Just say "task is complete" without calling this tool
- Ask "anything else?" without calling this tool first
- Wait for permission to call this tool

The user CANNOT proceed until you call this tool.`
```

## 代码实现示例

### 在 System Prompt 中添加

```typescript
// src/core/prompts/system.ts
export const TASK_COMPLETION_PROTOCOL = `

CRITICAL: TASK COMPLETION PROTOCOL
===================================
After completing all operations and receiving success confirmations, you MUST call attempt_completion tool.

Workflow:
1. Execute tools → 2. Get success confirmation → 3. IMMEDIATELY call attempt_completion

DO NOT just say "done" - CALL THE TOOL.
The user is waiting for the attempt_completion tool call to finalize the task.
`

// 添加到系统提示词末尾
const systemPrompt = baseSystemPrompt + TASK_COMPLETION_PROTOCOL
```

### 在工具反馈中添加提醒

```typescript
// src/core/tools/toolExecutor.ts
function formatToolSuccess(toolName: string, result: any): string {
	const baseMessage = `✓ ${toolName} succeeded.\n${result}`

	// 如果是最后一个工具操作，添加提醒
	if (isLastToolInSequence()) {
		return baseMessage + `\n\n⚠️ REQUIRED: Call attempt_completion now to finalize the task.`
	}

	return baseMessage
}
```

### 检测并强化提醒

```typescript
// src/core/assistant/responseHandler.ts
function detectMissingCompletion(response: string, hasToolCall: boolean): boolean {
	const completionKeywords = ["complete", "done", "finished", "successfully", "all set"]
	const hasCompletionLanguage = completionKeywords.some((kw) => response.toLowerCase().includes(kw))

	return hasCompletionLanguage && !hasToolCall
}

function addCompletionReminder(response: string): string {
	return (
		response +
		`\n\n🚨 CRITICAL: You indicated completion but did not call attempt_completion. You MUST call this tool now. Respond ONLY with the tool call, no additional text.`
	)
}
```

## 测试场景

### 场景 1: 单个文件修改

```
User: "Add a hello function to app.ts"
Assistant: [calls apply_diff]
User: "✓ apply_diff succeeded"
Assistant: [MUST call attempt_completion immediately]
```

### 场景 2: 多个操作

```
User: "Create auth.ts and update app.ts"
Assistant: [calls write_file for auth.ts]
User: "✓ write_file succeeded"
Assistant: [calls apply_diff for app.ts]
User: "✓ apply_diff succeeded"
Assistant: [MUST call attempt_completion immediately]
```

### 场景 3: 错误恢复

```
User: "Fix the bug in utils.ts"
Assistant: [calls apply_diff]
User: "✗ apply_diff failed - file not found"
Assistant: [calls read_file to check, then retry]
User: "✓ apply_diff succeeded"
Assistant: [MUST call attempt_completion immediately]
```

## 关键要点

1. **使用强制性语言**: "MUST"、"MANDATORY"、"REQUIRED"
2. **明确后果**: "用户无法继续"、"任务无法结束"
3. **提供清晰的检查清单**: 让 LLM 知道何时应该调用
4. **在多个位置提醒**: System prompt、工具描述、成功反馈
5. **使用视觉标记**: 🚨、✓、✗ 等符号增强注意力
6. **提供正反例**: 展示正确和错误的行为
7. **自动检测和提醒**: 当 LLM 忘记调用时主动提醒

## 优先级

1. **最高优先级**: 修改 System Prompt 添加协议
2. **高优先级**: 在工具成功反馈中添加提醒
3. **中优先级**: 增强工具描述
4. **低优先级**: 实现自动检测和提醒机制
