# Native Tool Calling Flow Documentation

## Overview

This document describes the native tool calling implementation for Gemini CLI provider in KiloCode, including the complete flow from API request to conversation history persistence.

## Architecture

### Key Components

1. **gemini-cli.ts** - Gemini OAuth API provider that yields `native_tool_calls` events
2. **AssistantMessageParser.ts** - Converts native tool calls to Anthropic ToolUse format
3. **Task.ts** - Manages conversation history and persists tool calls to API history
4. **gemini-format.ts** - Transforms between Anthropic and Gemini message formats

## Complete Flow

```
User Request
    ↓
Task.ts (attemptApiRequest)
    ↓
gemini-cli.ts (createMessage)
    ↓
Gemini API (streamGenerateContent)
    ↓
SSE Stream with functionCall
    ↓
gemini-cli.ts yields native_tool_calls
    ↓
Task.ts receives native_tool_calls chunk
    ↓
AssistantMessageParser.processNativeToolCalls()
    ↓
Converts to ToolUse format (type, id, name, input)
    ↓
Stored in assistantMessageContent[]
    ↓
Task.ts saves to apiConversationHistory
    ↓
Next API request includes tool calls in history
```

## Implementation Details

### 1. Gemini CLI Request Format (gemini-cli.ts)

When `toolStyle === "json"` and `allowedTools` are provided:

```typescript
const requestBody = {
	model: model,
	project: projectId,
	request: {
		contents: contents,
		systemInstruction: {
			role: "user",
			parts: [{ text: systemInstruction }],
		},
		tools: geminiTools, // Converted from allowedTools
		toolConfig: {
			functionCallingConfig: { mode: "ANY" },
		},
		generationConfig: {
			temperature: 0.7,
			maxOutputTokens: 8192,
		},
	},
}
```

**Key Points:**

- `systemInstruction`, `tools`, and `toolConfig` must be inside `request` object
- `toolConfig.mode` should be "ANY" to force tool usage
- Tools are converted from OpenAI format to Gemini format

### 2. Gemini API Response Format

The API returns SSE events with `functionCall`:

```json
{
	"response": {
		"candidates": [
			{
				"content": {
					"role": "model",
					"parts": [
						{
							"functionCall": {
								"id": "call-123",
								"name": "read_file",
								"args": {
									"path": "config.json"
								}
							}
						}
					]
				}
			}
		]
	}
}
```

### 3. Native Tool Call Processing (gemini-cli.ts)

```typescript
if (part.functionCall && getActiveToolUseStyle(this.options) === "json") {
  const toolCallId = part.functionCall.id || `toolu_${part.functionCall.name}_${Date.now()}`
  yield {
    type: "native_tool_calls",
    toolCalls: [{
      id: toolCallId,
      type: "function",
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args || {})
      }
    }]
  }
}
```

**Key Points:**

- Generate fallback ID if Gemini doesn't provide one
- Format: `toolu_${name}_${timestamp}`
- Arguments are JSON stringified

### 4. Conversion to Anthropic Format (AssistantMessageParser.ts)

```typescript
processNativeToolCalls(toolCalls: NativeToolCall[]): void {
  for (const toolCall of toolCalls) {
    const toolUse: ToolUse = {
      type: "tool_use",
      name: toolCall.function.name as ToolName,
      params: JSON.parse(toolCall.function.arguments),
      partial: false
    }
    this.contentBlocks.push(toolUse)
  }
}
```

**Conversion:**

- `native_tool_calls` → `ToolUse` format
- `toolCall.function.name` → `name`
- `toolCall.function.arguments` (JSON string) → `params` (object)
- `partial: false` since native calls are complete

### 5. Persistence to API History (Task.ts)

**CRITICAL FIX:** Line 2430-2437

```typescript
await this.addToApiConversationHistory({
	role: "assistant",
	content:
		this.assistantMessageContent.length > 0
			? this.assistantMessageContent.map((block) => {
					if (block.type === "text") return { type: "text", text: block.content || "" }
					if (block.type === "tool_use")
						return {
							type: "tool_use",
							id: `toolu_${block.name}_${Date.now()}`,
							name: block.name,
							input: block.params,
						}
					return { type: "text", text: "" }
				})
			: [{ type: "text", text: assistantMessage }],
})
```

**Key Points:**

- Save complete `assistantMessageContent` array, not just text
- Convert `TextContent` → `{ type: "text", text: block.content }`
- Convert `ToolUse` → `{ type: "tool_use", id, name, input: block.params }`
- Generate tool call ID since `ToolUse` doesn't have `id` field

### 6. Tool Response Format (gemini-format.ts)

When converting tool results back to Gemini format:

```typescript
if (block.type === "tool_result") {
	return {
		functionResponse: {
			id: block.tool_use_id,
			name: toolName,
			response: {
				output:
					typeof block.content === "string"
						? block.content
						: block.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
			},
		},
	}
}
```

**Key Points:**

- `tool_result` → `functionResponse`
- Must include `id`, `name`, and `response.output`
- `response.output` contains the tool execution result

## Bug Fix Summary

### Problem

Assistant messages with tool calls had empty `parts` arrays in conversation history, causing subsequent API requests to fail.

### Root Cause

Task.ts line 2430 only saved text content to API history:

```typescript
content: [{ type: "text", text: assistantMessage }]
```

This omitted tool_use blocks from `assistantMessageContent`.

### Solution

Save complete `assistantMessageContent` array with proper type conversion:

- TextContent: `block.content` → `text`
- ToolUse: `block.params` → `input`, generate `id`

## Type Definitions

### AssistantMessageContent

```typescript
type AssistantMessageContent = TextContent | ToolUse

interface TextContent {
	type: "text"
	content: string
	partial: boolean
}

interface ToolUse {
	type: "tool_use"
	name: ToolName
	params: Partial<Record<ToolParamName, string>>
	partial: boolean
}
```

### Anthropic ContentBlockParam

```typescript
type ContentBlockParam = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object }
```

## Testing Checklist

- [ ] Native tool calls are yielded from gemini-cli.ts
- [ ] Tool calls are converted to ToolUse format
- [ ] Tool calls are stored in assistantMessageContent
- [ ] Tool calls are persisted to apiConversationHistory
- [ ] Next API request includes tool calls in conversation history
- [ ] Tool responses are properly formatted with functionResponse
- [ ] Multi-turn tool calling works correctly

## Related Files

- `src/api/providers/gemini-cli.ts` - Native tool call generation
- `src/api/transform/gemini-format.ts` - Format conversion
- `src/core/assistant-message/AssistantMessageParser.ts` - Tool call parsing
- `src/core/task/Task.ts` - History persistence
- `GEMINI_OAUTH_STREAMING_TOOL_CALLING.md` - API specification
