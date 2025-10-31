# 斜杠命令处理逻辑

## 概述

斜杠命令（Slash Commands）是 Kilo Code 中用户与 AI 交互的特殊指令，以 `/` 开头，用于触发特定功能。本文档详细说明斜杠命令的处理流程、涉及的代码文件以及与 ToolUseStyle 的关系。

## 支持的斜杠命令

### 内置命令

| 命令         | 功能             | 实现函数                |
| ------------ | ---------------- | ----------------------- |
| `/newtask`   | 创建新的子任务   | `newTaskToolResponse`   |
| `/newrule`   | 创建新的规则文件 | `newRuleToolResponse`   |
| `/reportbug` | 报告 bug         | `reportBugToolResponse` |
| `/smol`      | 压缩上下文       | `condenseToolResponse`  |

### 工作流命令

用户可以在 `.kilocode/rules/` 目录下创建自定义工作流文件，文件名即为命令名。例如：

- 文件：`.kilocode/rules/test.workflow`
- 命令：`/test.workflow`

## 处理流程

### 1. 触发时机

斜杠命令在用户消息被发送到 LLM 之前处理，具体在以下标签内的文本中识别：

- `<task>` - 初始任务描述
- `<feedback>` - 用户反馈
- `<answer>` - 用户回答
- `<user_message>` - 用户消息

### 2. 处理流程图

```
用户输入
    ↓
Task.recursivelyMakeClineRequests()
    ↓
processKiloUserContentMentions()
    ↓
检查 block.type
    ├─ "text" → 处理文本块
    └─ "tool_result" → 处理工具结果块
        ├─ string content
        └─ array content
    ↓
shouldProcessMentions() 检查标签
    ↓
parseMentions() 处理 @ 引用
    ↓
parseKiloSlashCommands() 处理斜杠命令
    ↓
返回处理后的文本
```

### 3. 详细步骤

#### 步骤 1: 内容块类型检查

`processKiloUserContentMentions` 函数遍历所有用户内容块：

```typescript
// 支持两种块类型
if (block.type === "text") {
	// 处理文本块
} else if (block.type === "tool_result") {
	// 处理工具结果块（JSON toolStyle 时使用）
}
```

#### 步骤 2: 标签检查

只处理包含特定标签的文本：

```typescript
const shouldProcessMentions = (text: string) =>
	text.includes("<task>") ||
	text.includes("<feedback>") ||
	text.includes("<answer>") ||
	text.includes("<user_message>")
```

#### 步骤 3: Mentions 处理

先处理 `@` 引用（文件、URL 等）：

```typescript
const parsedText = await parseMentions(
	block.text,
	cwd,
	urlContentFetcher,
	fileContextTracker,
	// ...
)
```

#### 步骤 4: 斜杠命令处理

然后处理斜杠命令：

```typescript
const { processedText, needsRulesFileCheck } = await parseKiloSlashCommands(
	parsedText,
	localWorkflowToggles,
	globalWorkflowToggles,
)
```

## 与 ToolUseStyle 的关系

### XML 模式 (`toolStyle === "xml"`)

- 用户反馈通常在 `text` 块中
- 斜杠命令在 `text` 块中被处理
- 工具调用以 XML 文本格式表示

### JSON 模式 (`toolStyle === "json"`)

- 用户反馈可能在 `tool_result` 块中
- **关键修复**：需要在 `tool_result` 块中也处理斜杠命令
- 工具调用以 OpenAI 原生 `tool_calls` 格式表示

### 历史问题（已修复）

**问题**：在 commit `1fa047786514dd1d5cced7f0db3323766b2f9e10` 之前，`tool_result` 块中的斜杠命令不会被处理。

**影响**：当使用 JSON toolStyle 时，用户在工具结果反馈中输入的斜杠命令会被忽略。

**修复**：在 `processKiloUserContentMentions.ts` 中为 `tool_result` 块添加了 `parseKiloSlashCommands` 调用。

## 涉及的代码文件

### 核心文件

#### 1. `src/core/mentions/processKiloUserContentMentions.ts`

**职责**：处理用户内容中的 mentions 和斜杠命令

**关键函数**：

- `processKiloUserContentMentions()` - 主入口函数
- `shouldProcessMentions()` - 检查是否需要处理
- `processUserContentMentions()` - 内部处理逻辑

**处理的块类型**：

- `text` 块：直接处理 `block.text`
- `tool_result` 块：
    - 字符串内容：处理 `block.content`
    - 数组内容：处理每个 `contentBlock.text`

#### 2. `src/core/slash-commands/kilo.ts`

**职责**：解析和执行斜杠命令

**关键函数**：

- `parseKiloSlashCommands()` - 主解析函数

**处理逻辑**：

1. 使用正则表达式匹配斜杠命令
2. 检查是否为内置命令
3. 检查是否为工作流命令
4. 移除命令文本，插入相应的指令

**正则表达式**：

```typescript
const tagPatterns = [
	{ tag: "task", regex: /<task>(\s*\/([a-zA-Z0-9_.-]+))(\s+.+?)?\s*<\/task>/is },
	{ tag: "feedback", regex: /<feedback>(\s*\/([a-zA-Z0-9_.-]+))(\s+.+?)?\s*<\/feedback>/is },
	{ tag: "answer", regex: /<answer>(\s*\/([a-zA-Z0-9_.-]+))(\s+.+?)?\s*<\/answer>/is },
	{ tag: "user_message", regex: /<user_message>(\s*\/([a-zA-Z0-9_.-]+))(\s+.+?)?\s*<\/user_message>/is },
]
```

**注意**：正则支持命令名中包含点号（`.`），如 `/run.test`

#### 3. `src/core/prompts/commands.ts`

**职责**：定义内置命令的响应模板

**导出函数**：

- `newTaskToolResponse()` - 新任务指令
- `newRuleToolResponse()` - 新规则指令
- `reportBugToolResponse()` - 报告 bug 指令
- `condenseToolResponse()` - 压缩上下文指令

#### 4. `src/core/context/instructions/workflows.ts`

**职责**：管理工作流文件的加载和切换

**关键函数**：

- `refreshWorkflowToggles()` - 刷新本地和全局工作流

**工作流位置**：

- 本地：`{workspace}/.kilocode/rules/`
- 全局：`~/.kilocode/rules/`

### 调用链

```
Task.recursivelyMakeClineRequests()
    ↓
processKiloUserContentMentions()
    ├─ refreshWorkflowToggles()
    ├─ parseMentions()
    └─ parseKiloSlashCommands()
        ├─ 内置命令 → commands.ts
        └─ 工作流命令 → 读取文件
```

## 命令格式规范

### 基本格式

```
<tag>/command [arguments]</tag>
```

### 示例

```xml
<!-- 创建新任务 -->
<task>/newtask 实现登录功能</task>

<!-- 创建新规则 -->
<feedback>/newrule 添加代码审查规则</feedback>

<!-- 使用工作流 -->
<user_message>/test.workflow 运行测试</user_message>

<!-- 压缩上下文 -->
<answer>/smol</answer>
```

### 命名规则

- 命令名支持：字母、数字、下划线、连字符、点号
- 正则：`[a-zA-Z0-9_.-]+`
- 大小写敏感

## 测试场景

### 1. XML ToolStyle 测试

```typescript
// 用户输入在 text 块中
{
    type: "text",
    text: "<task>/newtask 创建测试</task>"
}
// ✅ 应该被正确处理
```

### 2. JSON ToolStyle 测试

```typescript
// 用户输入在 tool_result 块中（字符串）
{
    type: "tool_result",
    tool_use_id: "xxx",
    content: "<feedback>/newrule 添加规则</feedback>"
}
// ✅ 应该被正确处理（修复后）
```

```typescript
// 用户输入在 tool_result 块中（数组）
{
    type: "tool_result",
    tool_use_id: "xxx",
    content: [
        { type: "text", text: "<answer>/smol</answer>" }
    ]
}
// ✅ 应该被正确处理（修复后）
```

### 3. 工作流命令测试

```typescript
// 自定义工作流
{
    type: "text",
    text: "<task>/my.workflow 执行自定义流程</task>"
}
// ✅ 应该读取 .kilocode/rules/my.workflow 文件
```

## 注意事项

1. **处理顺序**：先处理 mentions，再处理斜杠命令
2. **标签要求**：斜杠命令必须在支持的标签内才会被处理
3. **工具结果块**：JSON toolStyle 下必须处理 `tool_result` 块
4. **文件检查**：`/newrule` 命令会触发 `.kilocode/rules/` 目录检查
5. **命令移除**：处理后斜杠命令文本会被移除，替换为相应指令

## 相关文档

- [tool-use-style-consistency.md](./tool-use-style-consistency.md) - ToolUseStyle 一致性问题
- [workspace-switching-analysis.md](./workspace-switching-analysis.md) - 工作区切换分析

## 修改历史

- **2025-01-XX**: 修复 JSON toolStyle 下 `tool_result` 块中斜杠命令不被处理的问题
- **2024-10-17**: Commit `1fa047786514dd1d5cced7f0db3323766b2f9e10` - 扩展支持 `<answer>` 和 `<user_message>` 标签，允许命令名包含点号
