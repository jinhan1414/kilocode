# Gemini CLI 搜索功能真实实现分析

## 重要发现：API 限制

**Gemini API 不支持同时使用 `googleSearch` 和 `functionDeclarations`！**

错误信息：

```
Multiple tools are supported only when they are all search tools.
```

## Gemini CLI 的解决方案

Gemini CLI 将 **Google Search 作为一个普通的 Function Tool** 实现，而不是使用 API 的 `googleSearch` 参数。

### 核心实现逻辑

#### 1. WebSearchTool 的特殊执行方式

```typescript
// packages/core/src/tools/web-search.ts
class WebSearchToolInvocation extends BaseToolInvocation {
	async execute(signal: AbortSignal): Promise<WebSearchToolResult> {
		const geminiClient = this.config.getGeminiClient()

		// 关键：创建一个独立的 API 调用，只使用 googleSearch
		const response = await geminiClient.generateContent(
			[{ role: "user", parts: [{ text: this.params.query }] }],
			{ tools: [{ googleSearch: {} }] }, // ← 单独调用，不包含其他工具
			signal,
		)

		// 处理 groundingMetadata
		const groundingMetadata = response.candidates?.[0]?.groundingMetadata
		// ...
	}
}
```

#### 2. 工具注册机制

```typescript
// packages/core/src/config/config.ts
async createToolRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry(this);

  // WebSearchTool 作为普通工具注册
  registerCoreTool(WebSearchTool, this);
  registerCoreTool(ReadFileTool, this);
  registerCoreTool(WriteFileTool, this);
  // ... 其他工具

  return registry;
}
```

#### 3. 工具声明转换

```typescript
// packages/core/src/tools/web-search.ts
export class WebSearchTool extends BaseDeclarativeTool {
	static readonly Name: string = "google_web_search"

	constructor(private readonly config: Config) {
		super(
			WebSearchTool.Name,
			"GoogleSearch",
			"Performs a web search using Google Search (via the Gemini API)",
			Kind.Search,
			{
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The search query to find information on the web.",
					},
				},
				required: ["query"],
			},
		)
	}
}
```

这个工具会被转换为 `functionDeclaration`：

```json
{
	"name": "google_web_search",
	"description": "Performs a web search using Google Search (via the Gemini API)",
	"parametersJsonSchema": {
		"type": "object",
		"properties": {
			"query": {
				"type": "string",
				"description": "The search query to find information on the web."
			}
		},
		"required": ["query"]
	}
}
```

## 完整工作流程

### 1. 初始 API 请求（包含所有工具）

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "搜索北京天气并保存到文件" }]
		}
	],
	"tools": [
		{
			"functionDeclarations": [
				{
					"name": "google_web_search",
					"description": "Performs a web search using Google Search",
					"parametersJsonSchema": {
						"type": "object",
						"properties": {
							"query": { "type": "string" }
						},
						"required": ["query"]
					}
				},
				{
					"name": "write_file",
					"description": "写入文件",
					"parametersJsonSchema": {
						"type": "object",
						"properties": {
							"path": { "type": "string" },
							"content": { "type": "string" }
						},
						"required": ["path", "content"]
					}
				}
			]
		}
	]
}
```

### 2. Gemini 决定调用 google_web_search

```json
{
	"candidates": [
		{
			"content": {
				"parts": [
					{
						"functionCall": {
							"name": "google_web_search",
							"args": {
								"query": "北京天气"
							}
						}
					}
				]
			}
		}
	]
}
```

### 3. Gemini CLI 执行搜索工具

```typescript
// Turn.run() 处理 functionCall
const fnCall = resp.functionCalls[0]
// fnCall.name = "google_web_search"
// fnCall.args = { query: "北京天气" }

// 获取工具实例
const tool = toolRegistry.getTool("google_web_search")

// 执行工具 - 这里会发起独立的 API 调用
const result = await tool.execute(signal)
```

### 4. WebSearchTool 内部的独立 API 调用

```bash
# 这是 WebSearchTool.execute() 内部发起的请求
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent

{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "北京天气" }]
    }
  ],
  "tools": [
    { "googleSearch": {} }  # ← 只有搜索工具，没有其他 functionDeclarations
  ]
}
```

### 5. 返回搜索结果给主对话

```json
{
	"role": "user",
	"parts": [
		{
			"functionResponse": {
				"name": "google_web_search",
				"response": {
					"llmContent": "Web search results for \"北京天气\":\n\n今天北京天气晴朗[1]...\n\nSources:\n[1] 中国天气网 (https://weather.com.cn/beijing)"
				}
			}
		}
	]
}
```

### 6. Gemini 继续处理并调用 write_file

```json
{
	"candidates": [
		{
			"content": {
				"parts": [
					{
						"functionCall": {
							"name": "write_file",
							"args": {
								"path": "weather.txt",
								"content": "今天北京天气晴朗..."
							}
						}
					}
				]
			}
		}
	]
}
```

## 关键代码路径

### 1. 工具调用入口

```typescript
// packages/core/src/core/turn.ts
async *run(req: PartListUnion, signal: AbortSignal) {
  const responseStream = await this.chat.sendMessageStream({
    message: req,
    config: { abortSignal: signal }
  }, this.prompt_id);

  for await (const resp of responseStream) {
    // 处理 functionCalls
    const functionCalls = resp.functionCalls ?? [];
    for (const fnCall of functionCalls) {
      const event = this.handlePendingFunctionCall(fnCall);
      if (event) {
        yield event;  // 发出 ToolCallRequest 事件
      }
    }
  }
}
```

### 2. 工具执行调度

```typescript
// packages/core/src/core/coreToolScheduler.ts
async executeToolCall(
  toolCallRequest: ToolCallRequestInfo,
  signal: AbortSignal
): Promise<ToolCallResponseInfo> {
  const tool = this.toolRegistry.getTool(toolCallRequest.name);

  // 执行工具（对于 WebSearchTool，这里会发起独立的 API 调用）
  const result = await tool.execute(toolCallRequest.args, signal);

  return {
    callId: toolCallRequest.callId,
    responseParts: [{ functionResponse: { name: tool.name, response: result } }],
    resultDisplay: result.returnDisplay,
    error: undefined,
    errorType: undefined
  };
}
```

## 正确的 HTTP 请求方式

### 方式一：只使用 Google Search（无其他工具）

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "今天北京的天气怎么样？" }]
		}
	],
	"tools": [{ "googleSearch": {} }]
}
```

### 方式二：将 Google Search 作为 Function Tool（推荐）

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "搜索北京天气并保存到文件" }]
		}
	],
	"tools": [
		{
			"functionDeclarations": [
				{
					"name": "google_web_search",
					"description": "Performs a web search using Google Search. When called, this will trigger a separate API call with googleSearch enabled.",
					"parametersJsonSchema": {
						"type": "object",
						"properties": {
							"query": {
								"type": "string",
								"description": "The search query"
							}
						},
						"required": ["query"]
					}
				},
				{
					"name": "write_file",
					"description": "写入文件",
					"parametersJsonSchema": {
						"type": "object",
						"properties": {
							"path": { "type": "string" },
							"content": { "type": "string" }
						},
						"required": ["path", "content"]
					}
				}
			]
		}
	]
}
```

然后在你的代码中处理 `google_web_search` 的 functionCall：

```python
def handle_function_call(function_call):
    if function_call['name'] == 'google_web_search':
        # 发起独立的 API 调用
        search_response = requests.post(
            f"{API_URL}?key={API_KEY}",
            json={
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": function_call['args']['query']}]
                    }
                ],
                "tools": [{"googleSearch": {}}]  # 只有搜索工具
            }
        )

        # 提取结果
        result = search_response.json()
        text = result['candidates'][0]['content']['parts'][0]['text']
        grounding_metadata = result['candidates'][0].get('groundingMetadata', {})

        # 格式化来源
        sources = []
        for chunk in grounding_metadata.get('groundingChunks', []):
            sources.append(f"{chunk['web']['title']} ({chunk['web']['uri']})")

        return {
            "llmContent": f"Web search results:\n\n{text}\n\nSources:\n" + "\n".join(sources),
            "returnDisplay": "Search completed"
        }

    elif function_call['name'] == 'write_file':
        # 处理文件写入
        with open(function_call['args']['path'], 'w') as f:
            f.write(function_call['args']['content'])
        return {
            "llmContent": "File written successfully",
            "returnDisplay": "File saved"
        }
```

## 完整 Python 实现示例

```python
import requests
import json

API_KEY = "YOUR_API_KEY"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

def google_web_search(query):
    """执行 Google 搜索（独立 API 调用）"""
    response = requests.post(
        f"{API_URL}?key={API_KEY}",
        json={
            "contents": [{"role": "user", "parts": [{"text": query}]}],
            "tools": [{"googleSearch": {}}]
        }
    )
    result = response.json()
    text = result['candidates'][0]['content']['parts'][0]['text']
    grounding_metadata = result['candidates'][0].get('groundingMetadata', {})

    # 格式化来源
    sources = []
    for idx, chunk in enumerate(grounding_metadata.get('groundingChunks', []), 1):
        title = chunk.get('web', {}).get('title', 'Untitled')
        uri = chunk.get('web', {}).get('uri', 'No URI')
        sources.append(f"[{idx}] {title} ({uri})")

    formatted_result = f"{text}\n\nSources:\n" + "\n".join(sources)
    return formatted_result

def write_file(path, content):
    """写入文件"""
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    return f"File written to {path}"

# 主对话循环
history = []

def send_message(user_message):
    history.append({
        "role": "user",
        "parts": [{"text": user_message}]
    })

    response = requests.post(
        f"{API_URL}?key={API_KEY}",
        json={
            "contents": history,
            "tools": [{
                "functionDeclarations": [
                    {
                        "name": "google_web_search",
                        "description": "Performs a web search",
                        "parametersJsonSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string"}
                            },
                            "required": ["query"]
                        }
                    },
                    {
                        "name": "write_file",
                        "description": "写入文件",
                        "parametersJsonSchema": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "content": {"type": "string"}
                            },
                            "required": ["path", "content"]
                        }
                    }
                ]
            }]
        }
    )

    result = response.json()
    model_response = result['candidates'][0]['content']
    history.append(model_response)

    # 处理 function calls
    for part in model_response.get('parts', []):
        if 'functionCall' in part:
            fn_call = part['functionCall']
            fn_name = fn_call['name']
            fn_args = fn_call['args']

            print(f"调用工具: {fn_name}({fn_args})")

            # 执行工具
            if fn_name == 'google_web_search':
                result = google_web_search(fn_args['query'])
            elif fn_name == 'write_file':
                result = write_file(fn_args['path'], fn_args['content'])

            # 返回结果给模型
            history.append({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": fn_name,
                        "response": {"result": result}
                    }
                }]
            })

            # 继续对话
            return send_message("")  # 空消息让模型继续

        elif 'text' in part:
            print(f"模型回复: {part['text']}")
            return part['text']

# 使用示例
send_message("搜索北京天气并保存到 weather.txt")
```

## 总结

### Gemini CLI 的实现策略

1. **将 Google Search 包装为普通 Function Tool**
2. **在工具执行时发起独立的 API 调用**（只包含 `googleSearch`）
3. **将搜索结果作为 functionResponse 返回给主对话**

### 为什么这样设计

- **绕过 API 限制**：避免同时使用 `googleSearch` 和 `functionDeclarations`
- **统一工具接口**：所有工具（包括搜索）都通过相同的机制调用
- **灵活性**：可以在任何需要的时候调用搜索功能

### 关键要点

1. ❌ **不能**在同一个请求中同时使用 `googleSearch` 和 `functionDeclarations`
2. ✅ **可以**将搜索包装为 function tool，在执行时发起独立调用
3. ✅ **可以**在多轮对话中先搜索，再使用其他工具
4. ✅ **推荐**使用 Gemini CLI 的方式：function tool + 独立 API 调用
