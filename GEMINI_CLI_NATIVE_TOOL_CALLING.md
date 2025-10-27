# Gemini CLI 原生工具调用实现文档

## 概述

本文档记录了为 `gemini-cli.ts` 添加原生工具调用（Native Tool Calling）支持的实现细节。该功能允许 Gemini CLI 提供商在 `toolStyle` 设置为 `"json"` 时，使用 Gemini API 的原生函数调用功能，而不是基于 XML 的工具调用方式。

## 变更日期

2024年（具体日期根据实际情况填写）

## 相关文件

- `src/api/providers/gemini-cli.ts` - 主要实现文件
- `src/api/providers/kilocode/nativeToolCallHelpers.ts` - 参考实现（OpenAI 风格）
- `GEMINI_OAUTH_STREAMING_TOOL_CALLING.md` - Gemini API 文档参考

## 实现原理

### 1. 工作流程

```
用户请求 → 检查 toolStyle
    ↓
toolStyle === "json" ?
    ↓ 是
转换 OpenAI 工具格式 → Gemini 工具格式
    ↓
添加到请求体 (tools + toolConfig)
    ↓
发送流式请求
    ↓
接收响应中的 functionCall
    ↓
转换为 native_tool_calls 格式
    ↓
返回给调用方处理
```

### 2. 核心组件

#### 2.1 工具格式转换

**输入格式（OpenAI）：**

```typescript
{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { /* JSON Schema */ }
  }
}
```

**输出格式（Gemini）：**

```typescript
{
	functionDeclarations: [
		{
			name: "read_file",
			description: "Read a file",
			parameters: {
				/* JSON Schema */
			},
		},
	]
}
```

#### 2.2 响应格式转换

**Gemini 响应：**

```typescript
{
  functionCall: {
    id: "call-123",
    name: "read_file",
    args: { path: "config.json" }
  }
}
```

**转换为标准格式：**

```typescript
{
  type: "native_tool_calls",
  toolCalls: [
    {
      id: "call-123",
      type: "function",
      function: {
        name: "read_file",
        arguments: '{"path":"config.json"}'
      }
    }
  ]
}
```

## 代码变更详情

### 1. 导入依赖

```typescript
// 新增导入
import OpenAI from "openai"
import { getActiveToolUseStyle } from "@roo-code/types"
```

**说明：**

- `OpenAI` - 用于类型定义（`ChatCompletionTool`）
- `getActiveToolUseStyle` - 检查当前工具使用风格

### 2. 传递 metadata 参数

**修改位置：** `createMessage` 和 `_createMessageRecursive` 方法

```typescript
// 修改前
async *createMessage(
  systemInstruction: string,
  messages: Anthropic.Messages.MessageParam[],
): ApiStream

// 修改后
async *createMessage(
  systemInstruction: string,
  messages: Anthropic.Messages.MessageParam[],
  metadata?: ApiHandlerCreateMessageMetadata,  // 新增
): ApiStream
```

**说明：** `metadata` 包含 `allowedTools` 字段，存储当前模式允许的工具定义。

### 3. 添加工具定义到请求

**位置：** `_createMessageRecursive` 方法中，构建 `requestBody` 之后

```typescript
// kilocode_change start: Add native tool call support when toolStyle is "json"
if (getActiveToolUseStyle(this.options) === "json" && metadata?.allowedTools) {
	requestBody.request.tools = this.convertOpenAIToolsToGemini(metadata.allowedTools)
	requestBody.request.toolConfig = {
		functionCallingConfig: { mode: "AUTO" },
	}
}
// kilocode_change end
```

**说明：**

- 仅在 `toolStyle === "json"` 且有工具定义时启用
- `mode: "AUTO"` 让模型自动决定是否调用工具

### 4. 处理流式响应中的工具调用

**位置：** SSE 流处理循环中，处理 `part.text` 之后

```typescript
// kilocode_change start: Handle native tool calls when toolStyle is "json"
if (part.functionCall && getActiveToolUseStyle(this.options) === "json") {
  yield {
    type: "native_tool_calls",
    toolCalls: [
      {
        id: part.functionCall.id || `${part.functionCall.name}-${Date.now()}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      },
    ],
  }
}
// kilocode_change end
```

**说明：**

- 检测到 `functionCall` 时转换为标准格式
- 如果没有 `id`，使用 `name + timestamp` 生成
- `args` 对象转换为 JSON 字符串

### 5. 工具格式转换函数

**位置：** 类的末尾，新增私有方法

```typescript
// kilocode_change start: Convert OpenAI tool format to Gemini format
private convertOpenAIToolsToGemini(tools: OpenAI.Chat.ChatCompletionTool[]): any[] {
  return [
    {
      functionDeclarations: tools
        .filter((tool) => 'function' in tool && tool.function !== undefined)
        .map((tool) => {
          const func = (tool as any).function
          return {
            name: func.name,
            description: func.description || "",
            parameters: func.parameters as Record<string, unknown>,
          }
        }),
    },
  ]
}
// kilocode_change end
```

**说明：**

- 过滤掉没有 `function` 属性的工具（处理联合类型）
- 使用类型断言 `(tool as any).function` 避免 TypeScript 错误
- 返回 Gemini 期望的 `functionDeclarations` 数组格式

## TypeScript 类型问题解决

### 问题 1: ChatCompletionTool 联合类型

**错误信息：**

```
Property 'function' does not exist on type 'ChatCompletionTool'.
Type 'ChatCompletionCustomTool' does not have property 'function'.
```

**原因：** `ChatCompletionTool` 是联合类型，包含 `ChatCompletionCustomTool`，后者没有 `function` 属性。

**解决方案：**

```typescript
.filter((tool) => 'function' in tool && tool.function !== undefined)
.map((tool) => {
  const func = (tool as any).function  // 类型断言
  // ...
})
```

### 问题 2: ApiStreamChunk 类型不匹配

**错误信息：**

```
Type '"tool_use"' is not assignable to type '"reasoning" | "error" | "text" | "usage" | "native_tool_calls" | "grounding"'
```

**原因：** 最初使用了 `type: "tool_use"`，但应该使用 `type: "native_tool_calls"`。

**解决方案：** 使用正确的类型 `"native_tool_calls"` 并包装在 `toolCalls` 数组中。

## 测试要点

### 1. 功能测试

- [ ] 验证 `toolStyle === "json"` 时工具定义正确添加到请求
- [ ] 验证 `toolStyle !== "json"` 时不添加工具定义
- [ ] 验证 Gemini 返回的 `functionCall` 正确转换为 `native_tool_calls`
- [ ] 验证工具调用的 `id`、`name`、`arguments` 字段正确

### 2. 边界情况

- [ ] `metadata` 为 `undefined` 时不崩溃
- [ ] `allowedTools` 为空数组时正常处理
- [ ] `functionCall.id` 不存在时生成备用 ID
- [ ] `functionCall.args` 为空时正确处理

### 3. 类型安全

- [ ] TypeScript 编译无错误
- [ ] 所有类型断言都有对应的运行时检查

## 与 OpenAI 实现的对比

| 特性         | OpenAI Handler                    | Gemini CLI Handler |
| ------------ | --------------------------------- | ------------------ |
| 工具定义格式 | OpenAI 原生格式                   | 转换为 Gemini 格式 |
| 响应处理     | `processNativeToolCallsFromDelta` | 自定义流式处理     |
| 工具调用累积 | OpenAI SDK 自动处理               | 手动解析 SSE 流    |
| ID 生成      | OpenAI 提供                       | 需要备用方案       |

## 已知限制

1. **不支持并行工具调用：** `toolConfig.mode` 固定为 `"AUTO"`，未实现 `"REQUIRED"` 或 `"NONE"` 模式
2. **ID 生成策略：** 当 Gemini 不返回 `id` 时，使用 `name + timestamp`，可能不够唯一
3. **错误处理：** 工具调用失败时的错误处理可能需要增强

## 前端配置界面

### UI 组件集成

前端已完全集成原生工具调用配置：

1. **ToolUseControl 组件**：

    ```typescript
    // webview-ui/src/components/settings/kilocode/ToolUseControl.tsx
    <ToolUseControl
      toolStyle={apiConfiguration.toolStyle}
      onChange={(field, value) => setApiConfigurationField(field, value)}
    />
    ```

2. **GeminiCli 提供商设置**：

    ```typescript
    // webview-ui/src/components/settings/providers/GeminiCli.tsx
    import { ToolUseControl } from "../kilocode/ToolUseControl"

    // 在组件中添加
    <ToolUseControl
      toolStyle={apiConfiguration.toolStyle}
      onChange={(field, value) => setApiConfigurationField(field, value)}
    />
    ```

3. **ApiOptions 集成**：
    ```typescript
    // 仅对支持原生工具调用的提供商显示
    {nativeFunctionCallingProviders.includes(selectedProvider) && (
      <ToolUseControl
        toolStyle={apiConfiguration.toolStyle}
        onChange={(field, value) => setApiConfigurationField(field, value)}
      />
    )}
    ```

### 用户配置步骤

用户可通过以下步骤配置原生工具调用：

1. **打开设置**：VS Code → Kilo Code 设置 → API Configuration
2. **选择提供商**：API Provider → "Gemini CLI"
3. **基本配置**：
    - OAuth Path: `~/.gemini/oauth_creds.json`
    - Project ID: `your-project-id` (可选)
4. **高级设置**：展开 "Advanced Settings"
5. **工具调用样式**：选择 Tool Call Style 选项

### Tool Call Style 选项说明

| 选项                    | 描述         | 行为                                  |
| ----------------------- | ------------ | ------------------------------------- |
| **Let Kilo decide**     | 智能自动选择 | 使用 `getActiveToolUseStyle` 逻辑决策 |
| **XML**                 | 传统格式     | 强制使用 XML 格式工具调用             |
| **JSON (experimental)** | 原生格式     | 启用 Gemini API 原生工具调用          |

## "Let Kilo decide" 智能决策机制

### 决策逻辑

当用户选择 "Let Kilo decide" 时，系统执行以下决策流程：

```typescript
export function getActiveToolUseStyle(settings: ProviderSettings | undefined): ToolUseStyle {
	// 1. 检查提供商支持
	if (!settings || (settings.apiProvider && !nativeFunctionCallingProviders.includes(settings.apiProvider))) {
		return "xml" // 不支持的提供商 → XML
	}

	// 2. 尊重用户明确选择
	if (settings.toolStyle) {
		return settings.toolStyle // 用户选择 → 遵循用户意愿
	}

	// 3. 检查模型特定规则
	const model = getModelId(settings)
	if (model && modelsDefaultingToNativeFunctionCalls.includes(model)) {
		return "json" // 特定模型 → JSON
	}

	// 4. 保守默认
	return "xml" // 其他情况 → XML
}
```

### 决策规则详解

#### 1. **提供商兼容性检查**

```typescript
const nativeFunctionCallingProviders = [
	"openrouter",
	"kilocode",
	"openai",
	"lmstudio",
	"chutes",
	"deepinfra",
	"xai",
	"zai",
	"gemini-cli",
]
```

- ✅ `gemini-cli` 在支持列表中
- ❌ 不支持的提供商自动使用 XML

#### 2. **用户选择优先**

- 如果用户明确选择了 "XML" 或 "JSON"，系统遵循用户意愿
- "Let Kilo decide" 对应 `toolStyle: undefined`

#### 3. **模型特定优化**

```typescript
const modelsDefaultingToNativeFunctionCalls = ["anthropic/claude-haiku-4.5"]
```

- 某些模型默认启用原生工具调用
- 当前 Gemini 模型不在此列表中

#### 4. **保守默认策略**

- 对于 Gemini CLI，"Let Kilo decide" 当前选择 **XML**
- 确保稳定性和兼容性
- 用户可手动选择 "JSON" 体验原生功能

### 对 Gemini CLI 的具体行为

当前配置下，"Let Kilo decide" 的决策路径：

1. ✅ **提供商检查**：`gemini-cli` 支持原生工具调用
2. ⏭️ **用户选择**：`toolStyle` 为 `undefined`，跳过
3. ❌ **模型检查**：Gemini 模型不在默认 JSON 列表中
4. 🛡️ **默认结果**：返回 `"xml"`

### 设计理念

- **🛡️ 稳定优先**：默认使用经过充分测试的 XML 格式
- **🎯 智能适配**：为特定模型提供最优配置
- **👤 用户至上**：始终尊重用户的明确选择
- **🔄 渐进增强**：随着功能成熟可调整默认行为

### 未来扩展

可通过修改配置为更多模型启用 JSON 默认：

```typescript
const modelsDefaultingToNativeFunctionCalls = [
	"anthropic/claude-haiku-4.5",
	"gemini-2.0-flash-exp", // 未来可能添加
	"gpt-4o", // 未来可能添加
]
```

## 后续改进建议

1. **支持更多 toolConfig 模式：**

    ```typescript
    toolConfig: {
    	functionCallingConfig: {
    		mode: metadata.toolChoice === "required" ? "ANY" : "AUTO"
    	}
    }
    ```

2. **改进 ID 生成：**

    ```typescript
    id: part.functionCall.id || `${part.functionCall.name}-${crypto.randomUUID()}`
    ```

3. **添加工具调用日志：**

    ```typescript
    console.debug(`[GeminiCLI] Tool call: ${part.functionCall.name}`, part.functionCall.args)
    ```

4. **支持工具调用历史：**

    - 利用 Gemini 的 `automaticFunctionCallingHistory` 字段
    - 实现多轮工具调用

5. **智能默认策略优化：**
    - 根据模型性能数据调整 `modelsDefaultingToNativeFunctionCalls`
    - 添加用户反馈机制优化决策逻辑

## 配置示例

### 后端配置

```typescript
// API Handler Options
const geminiCliSettings: ApiHandlerOptions = {
	apiProvider: "gemini-cli",
	toolStyle: "json", // 启用原生工具调用
	apiModelId: "gemini-2.0-flash-exp",
	geminiCliOAuthPath: "~/.gemini/oauth_creds.json",
	geminiCliProjectId: "my-project-123",
	modelTemperature: 0.1,
	modelMaxTokens: 8192,
}
```

### 前端配置

```typescript
// Provider Settings
const providerSettings: ProviderSettings = {
	apiProvider: "gemini-cli",
	toolStyle: "json", // 选项: undefined | "xml" | "json"
	apiModelId: "gemini-2.0-flash-exp",
	geminiCliOAuthPath: "~/.gemini/oauth_creds.json",
	geminiCliProjectId: "my-project-123",
}
```

### 用户界面配置

```
API Provider: Gemini CLI
Model: gemini-2.0-flash-exp
OAuth Path: ~/.gemini/oauth_creds.json
Project ID: my-project-123

[Advanced Settings ▼]
├── Tool Call Style: JSON (experimental) ✨
│   ├── Let Kilo decide (默认使用 XML)
│   ├── XML (传统格式)
│   └── JSON (experimental) (原生工具调用)
├── Temperature: 0.1
├── Rate Limit: 0 seconds
└── ...其他高级选项
```

## 测试指南

### 功能测试

- [ ] 验证 `toolStyle === "json"` 时工具定义正确添加到请求
- [ ] 验证 `toolStyle !== "json"` 时不添加工具定义
- [ ] 验证 Gemini 返回的 `functionCall` 正确转换为 `native_tool_calls`
- [ ] 验证工具调用的 `id`、`name`、`arguments` 字段正确
- [ ] 验证 "Let Kilo decide" 选项正确返回 XML 格式
- [ ] 验证前端 UI 组件正确显示和交互

### 边界情况

- [ ] `metadata` 为 `undefined` 时不崩溃
- [ ] `allowedTools` 为空数组时正常处理
- [ ] `functionCall.id` 不存在时生成备用 ID
- [ ] `functionCall.args` 为空时正确处理
- [ ] 提供商不支持时自动回退到 XML

### 类型安全

- [ ] TypeScript 编译无错误
- [ ] 所有类型断言都有对应的运行时检查
- [ ] UI 组件类型安全

## 参考资料

- [Gemini OAuth 流式工具调用 API 文档](./GEMINI_OAUTH_STREAMING_TOOL_CALLING.md)
- [OpenAI 工具调用文档](https://platform.openai.com/docs/guides/function-calling)
- [nativeToolCallHelpers 实现](./src/api/providers/kilocode/nativeToolCallHelpers.ts)
- [ToolUseControl 组件](./webview-ui/src/components/settings/kilocode/ToolUseControl.tsx)
- [getActiveToolUseStyle 函数](./packages/types/src/kilocode/native-function-calling.ts)

## 维护者

- 初始实现：Amazon Q Developer
- 最后更新：2024年

## 变更日志

| 日期       | 变更内容                        | 作者     |
| ---------- | ------------------------------- | -------- |
| 2024-XX-XX | 初始实现原生工具调用支持        | Amazon Q |
| 2024-XX-XX | 修复 TypeScript 类型错误        | Amazon Q |
| 2024-XX-XX | 添加前端 UI 配置支持            | Amazon Q |
| 2024-XX-XX | 完善 "Let Kilo decide" 机制文档 | Amazon Q |
