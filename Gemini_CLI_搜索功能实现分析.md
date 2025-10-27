# Gemini CLI 内置联网搜索功能实现分析

## 核心原理

Gemini CLI 通过 **Gemini API 的 Google Search Grounding 功能** 实现联网搜索，而非直接调用 Google Search API。

## 实现架构

### 1. 工具定义 (`packages/core/src/tools/web-search.ts`)

```typescript
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

### 2. 搜索执行核心逻辑

```typescript
async execute(signal: AbortSignal): Promise<WebSearchToolResult> {
  const geminiClient = this.config.getGeminiClient();

  // 关键：向 Gemini API 传入 googleSearch 工具配置
  const response = await geminiClient.generateContent(
    [{ role: 'user', parts: [{ text: this.params.query }] }],
    { tools: [{ googleSearch: {} }] },  // ← 启用 Google Search
    signal,
  );

  // 提取搜索结果和元数据
  const responseText = getResponseText(response);
  const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
  const sources = groundingMetadata?.groundingChunks;
  const groundingSupports = groundingMetadata?.groundingSupports;

  // 处理引用标注和来源列表
  // ...
}
```

### 3. 工具注册 (`packages/core/src/config/config.ts`)

```typescript
async createToolRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry(this);

  registerCoreTool(LSTool, this);
  registerCoreTool(ReadFileTool, this);
  registerCoreTool(GrepTool, this);
  registerCoreTool(EditTool, this);
  registerCoreTool(WebSearchTool, this);  // ← 注册搜索工具

  await registry.discoverAllTools();
  return registry;
}
```

## 工作流程

```
用户查询
    ↓
Gemini 模型决定调用 google_web_search 工具
    ↓
WebSearchToolInvocation.execute()
    ↓
geminiClient.generateContent(query, { tools: [{ googleSearch: {} }] })
    ↓
Gemini API 执行 Google Search
    ↓
返回带 groundingMetadata 的响应
    ↓
提取 groundingChunks (来源) 和 groundingSupports (引用位置)
    ↓
格式化输出：插入引用标记 + 附加来源列表
    ↓
返回给用户
```

## 关键数据结构

### GroundingMetadata 结构

```typescript
interface GroundingChunkWeb {
	uri?: string // 来源 URL
	title?: string // 来源标题
}

interface GroundingSupportSegment {
	startIndex: number // 引用起始位置
	endIndex: number // 引用结束位置
	text?: string
}

interface GroundingSupportItem {
	segment?: GroundingSupportSegment
	groundingChunkIndices?: number[] // 引用的来源索引
	confidenceScores?: number[]
}
```

## 输出格式处理

### 引用标注插入

```typescript
// 在文本中插入引用标记 [1], [2] 等
if (groundingSupports && groundingSupports.length > 0) {
	const insertions: Array<{ index: number; marker: string }> = []
	groundingSupports.forEach((support) => {
		if (support.segment && support.groundingChunkIndices) {
			const citationMarker = support.groundingChunkIndices.map((chunkIndex) => `[${chunkIndex + 1}]`).join("")
			insertions.push({
				index: support.segment.endIndex,
				marker: citationMarker,
			})
		}
	})

	// 按索引降序排序，避免位置偏移
	insertions.sort((a, b) => b.index - a.index)

	// 插入标记
	const responseChars = modifiedResponseText.split("")
	insertions.forEach((insertion) => {
		responseChars.splice(insertion.index, 0, insertion.marker)
	})
	modifiedResponseText = responseChars.join("")
}
```

### 来源列表格式化

```typescript
// 生成来源列表
if (sources && sources.length > 0) {
	sources.forEach((source, index) => {
		const title = source.web?.title || "Untitled"
		const uri = source.web?.uri || "No URI"
		sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`)
	})

	// 附加到响应末尾
	modifiedResponseText += "\n\nSources:\n" + sourceListFormatted.join("\n")
}
```

## 输出示例

```
Web search results for "北京天气":

今天北京天气晴朗[1]，最高温度25度[2]，适合户外活动[1]。

Sources:
[1] 中国天气网 (https://weather.com.cn/beijing)
[2] 气象局官网 (https://cma.gov.cn)
```

## 核心优势

1. **无需额外 API Key** - 利用 Gemini API 内置能力
2. **自动引用标注** - 自动在文本中插入来源引用
3. **结构化元数据** - 提供完整的来源信息和置信度
4. **统一接口** - 作为标准工具集成到 Gemini CLI 工具系统

## 配置与使用

### 启用方式

搜索工具默认启用，无需额外配置。模型会根据用户查询自动决定是否调用。

### 手动调用

```bash
gemini
> 搜索最新的 AI 技术进展
```

### 非交互模式

```bash
gemini -p "搜索 TypeScript 最佳实践"
```

## 技术要点

- **工具类型**: `Kind.Search`
- **参数验证**: 确保 query 非空
- **错误处理**: 捕获网络错误和 API 异常
- **信号支持**: 支持 AbortSignal 取消请求
- **返回格式**: `WebSearchToolResult` 包含 `llmContent`、`returnDisplay` 和 `sources`

## HTTP API 调用格式

### 请求格式

#### Gemini API Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

#### 请求头

```http
Content-Type: application/json
User-Agent: GeminiCLI/{version} ({platform}; {arch})
```

#### 认证方式

**使用 API Key:**

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key={YOUR_API_KEY}
```

**使用 OAuth (Bearer Token):**

```http
Authorization: Bearer {ACCESS_TOKEN}
```

#### 请求体 (启用 Google Search)

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [
				{
					"text": "今天北京的天气怎么样？"
				}
			]
		}
	],
	"tools": [
		{
			"googleSearch": {} // ← 关键：启用 Google Search
		}
	],
	"generationConfig": {
		"temperature": 0,
		"topP": 1
	},
	"systemInstruction": {
		"parts": [
			{
				"text": "You are a helpful assistant..."
			}
		]
	}
}
```

### 响应格式

#### 成功响应结构

```json
{
	"candidates": [
		{
			"content": {
				"parts": [
					{
						"text": "今天北京天气晴朗，最高温度25度，适合户外活动。"
					}
				],
				"role": "model"
			},
			"finishReason": "STOP",
			"groundingMetadata": {
				"groundingChunks": [
					{
						"web": {
							"uri": "https://weather.com.cn/beijing",
							"title": "中国天气网 - 北京天气"
						}
					},
					{
						"web": {
							"uri": "https://cma.gov.cn",
							"title": "中国气象局官网"
						}
					}
				],
				"groundingSupports": [
					{
						"segment": {
							"startIndex": 0,
							"endIndex": 12,
							"text": "今天北京天气晴朗"
						},
						"groundingChunkIndices": [0],
						"confidenceScores": [0.95]
					},
					{
						"segment": {
							"startIndex": 13,
							"endIndex": 22,
							"text": "最高温度25度"
						},
						"groundingChunkIndices": [1],
						"confidenceScores": [0.92]
					}
				]
			},
			"safetyRatings": [
				{
					"category": "HARM_CATEGORY_HARASSMENT",
					"probability": "NEGLIGIBLE"
				}
			]
		}
	],
	"usageMetadata": {
		"promptTokenCount": 15,
		"candidatesTokenCount": 28,
		"totalTokenCount": 43
	}
}
```

#### 响应字段说明

| 字段路径                                    | 类型   | 说明                                        |
| ------------------------------------------- | ------ | ------------------------------------------- |
| `candidates[0].content.parts[0].text`       | string | 模型生成的文本响应                          |
| `candidates[0].groundingMetadata`           | object | 搜索结果的元数据                            |
| `groundingMetadata.groundingChunks`         | array  | 搜索来源列表                                |
| `groundingChunks[].web.uri`                 | string | 来源网页 URL                                |
| `groundingChunks[].web.title`               | string | 来源网页标题                                |
| `groundingMetadata.groundingSupports`       | array  | 引用支持信息                                |
| `groundingSupports[].segment`               | object | 被引用的文本片段位置                        |
| `groundingSupports[].segment.startIndex`    | number | 引用起始字符索引                            |
| `groundingSupports[].segment.endIndex`      | number | 引用结束字符索引                            |
| `groundingSupports[].groundingChunkIndices` | array  | 引用的来源索引（对应 groundingChunks 数组） |
| `groundingSupports[].confidenceScores`      | array  | 引用置信度分数 (0-1)                        |

### 完整 cURL 示例

#### 使用 API Key

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "今天北京的天气怎么样？"}]
      }
    ],
    "tools": [{"googleSearch": {}}]
  }'
```

#### 使用 OAuth Token

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "今天北京的天气怎么样？"}]
      }
    ],
    "tools": [{"googleSearch": {}}]
  }'
```

### Python 示例

````python
import requests
import json

url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

headers = {
    "Content-Type": "application/json"
}

params = {
    "key": "YOUR_API_KEY"
}

data = {
    "contents": [
        {
            "role": "user",
            "parts": [{"text": "今天北京的天气怎么样？"}]
        }
    ],
    "tools": [{"googleSearch": {}}]
}

response = requests.post(url, headers=headers, params=params, json=data)
result = response.json()

# 提取响应文本
text = result["candidates"][0]["content"]["parts"][0]["text"]
print(f"响应: {text}")

# 提取来源
if "groundingMetadata" in result["candidates"][0]:
    chunks = result["candidates"][0]["groundingMetadata"]["groundingChunks"]
    print("\n来源:")
    for i, chunk in enumerate(chunks):
        title = chunk["web"]["title"]
        uri = chunk["web"]["uri"]
        print(f"[{i+1}] {title} ({uri})")
```lt["candidates"][0]:
    chunks = result["candidates"][0]["groundingMetadata"]["groundingChunks"]
    print("\n来源:")
    for i, chunk in enumerate(chunks):
        title = chunk["web"]["title"]
        uri = chunk["web"]["uri"]
        print(f"[{i+1}] {title} ({uri})")
````

### JavaScript/TypeScript 示例

```typescript
interface SearchResponse {
	candidates: Array<{
		content: {
			parts: Array<{ text: string }>
			role: string
		}
		groundingMetadata?: {
			groundingChunks: Array<{
				web: {
					uri: string
					title: string
				}
			}>
			groundingSupports: Array<{
				segment: {
					startIndex: number
					endIndex: number
					text?: string
				}
				groundingChunkIndices: number[]
				confidenceScores?: number[]
			}>
		}
	}>
}

async function searchWithGemini(query: string, apiKey: string): Promise<void> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			contents: [
				{
					role: "user",
					parts: [{ text: query }],
				},
			],
			tools: [{ googleSearch: {} }],
		}),
	})

	const result: SearchResponse = await response.json()
	const candidate = result.candidates[0]

	// 输出响应文本
	console.log("响应:", candidate.content.parts[0].text)

	// 输出来源
	if (candidate.groundingMetadata) {
		console.log("\n来源:")
		candidate.groundingMetadata.groundingChunks.forEach((chunk, i) => {
			console.log(`[${i + 1}] ${chunk.web.title} (${chunk.web.uri})`)
		})
	}
}

// 使用示例
searchWithGemini("今天北京的天气怎么样？", "YOUR_API_KEY")
```

## 工具调用流程（functionCall/functionResponse）

### Google Search 的自动工具调用

**重要区别**：Google Search 使用 **自动工具调用**，不需要手动处理 `functionCall` 和 `functionResponse`。

```json
// Google Search - 自动处理
{
  "contents": [{"role": "user", "parts": [{"text": "今天北京天气"}]}],
  "tools": [{"googleSearch": {}}]  // ← API 自动执行搜索并返回结果
}

// 响应直接包含搜索结果和 groundingMetadata
{
  "candidates": [{
    "content": {
      "parts": [{"text": "今天北京天气晴朗..."}]  // ← 已包含搜索结果
    },
    "groundingMetadata": { /* 来源信息 */ }
  }]
}
```

### 自定义工具的手动调用流程

如果使用自定义工具（如 `read_file`、`search_files` 等），则需要手动处理工具调用：

#### 步骤 1：模型返回 functionCall

```json
// 请求
{
  "contents": [
    {"role": "user", "parts": [{"text": "搜索包含 'gemini' 的 TypeScript 文件"}]}
  ],
  "tools": [{
    "functionDeclarations": [{
      "name": "search_files",
      "description": "Search for files matching a pattern",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string"},
          "file_pattern": {"type": "string"},
          "regex": {"type": "string"}
        },
        "required": ["path", "file_pattern"]
      }
    }]
  }]
}

// 响应 - 模型请求调用工具
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [{
        "functionCall": {
          "id": "toolu_search_files_1761124234364",
          "name": "search_files",
          "args": {
            "path": ".",
            "file_pattern": "*.ts",
            "regex": "gemini.*search"
          }
        }
      }]
    }
  }]
}
```

#### 步骤 2：执行工具并返回 functionResponse

```json
// 下一次请求 - 包含完整历史 + 工具响应
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "搜索包含 'gemini' 的 TypeScript 文件" }]
		},
		{
			"role": "model",
			"parts": [
				{
					"functionCall": {
						"id": "toolu_search_files_1761124234364",
						"name": "search_files",
						"args": {
							"path": ".",
							"file_pattern": "*.ts",
							"regex": "gemini.*search"
						}
					}
				}
			]
		},
		{
			"role": "user",
			"parts": [
				{
					"functionResponse": {
						"id": "toolu_search_files_1761124234364",
						"name": "search_files",
						"response": {
							"output": "Found 1 result.\n\n# packages/cli/src/config/settingsSchema.ts\n245 | default: true,\n246 | description: 'Respect .geminiignore files when searching',\n247 | showInDialog: true,"
						}
					}
				}
			]
		}
	],
	"tools": [
		{
			"functionDeclarations": [
				/* 同上 */
			]
		}
	]
}
```

#### 步骤 3：模型返回最终答案

```json
{
	"candidates": [
		{
			"content": {
				"role": "model",
				"parts": [
					{
						"text": "我找到了 1 个包含 'gemini' 和 'search' 的 TypeScript 文件：\n\n在 packages/cli/src/config/settingsSchema.ts 文件中..."
					}
				]
			},
			"finishReason": "STOP"
		}
	]
}
```

### Python 工具调用示例

```python
import requests
import json

class GeminiToolChat:
    def __init__(self, api_key: str, model: str = "gemini-2.5-pro"):
        self.api_key = api_key
        self.model = model
        self.url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        self.history = []
        self.tools = []

    def add_tool(self, name: str, description: str, parameters: dict):
        """添加工具声明"""
        if not self.tools:
            self.tools = [{"functionDeclarations": []}]

        self.tools[0]["functionDeclarations"].append({
            "name": name,
            "description": description,
            "parameters": parameters
        })

    def send_message(self, message: str):
        """发送消息并处理工具调用"""
        # 添加用户消息
        self.history.append({
            "role": "user",
            "parts": [{"text": message}]
        })

        while True:
            # 发送请求
            data = {
                "contents": self.history,
                "tools": self.tools if self.tools else None
            }

            response = requests.post(
                self.url,
                headers={"Content-Type": "application/json"},
                params={"key": self.api_key},
                json=data
            )

            result = response.json()
            candidate = result["candidates"][0]
            parts = candidate["content"]["parts"]

            # 检查是否有 functionCall
            has_function_call = any("functionCall" in part for part in parts)

            if has_function_call:
                # 添加模型的 functionCall 到历史
                self.history.append({
                    "role": "model",
                    "parts": parts
                })

                # 执行工具并添加 functionResponse
                for part in parts:
                    if "functionCall" in part:
                        func_call = part["functionCall"]
                        print(f"[调用工具: {func_call['name']}]")

                        # 执行工具
                        result = self.execute_tool(
                            func_call["name"],
                            func_call["args"]
                        )

                        # 添加 functionResponse
                        self.history.append({
                            "role": "user",
                            "parts": [{
                                "functionResponse": {
                                    "id": func_call["id"],
                                    "name": func_call["name"],
                                    "response": {"output": result}
                                }
                            }]
                        })

                # 继续循环，获取最终答案
                continue
            else:
                # 没有工具调用，返回文本响应
                response_text = parts[0]["text"]
                self.history.append({
                    "role": "model",
                    "parts": [{"text": response_text}]
                })
                return response_text

    def execute_tool(self, name: str, args: dict) -> str:
        """执行工具（需要根据实际工具实现）"""
        if name == "search_files":
            # 实际实现文件搜索逻辑
            return f"Found files matching {args.get('file_pattern')}"
        return "Tool not implemented"

# 使用示例
chat = GeminiToolChat("YOUR_API_KEY")

# 添加工具
chat.add_tool(
    name="search_files",
    description="Search for files",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "file_pattern": {"type": "string"},
            "regex": {"type": "string"}
        },
        "required": ["path", "file_pattern"]
    }
)

# 发送消息（自动处理工具调用）
response = chat.send_message("搜索所有 TypeScript 文件")
print(response)
```

### 关键区别总结

| 特性                      | Google Search                    | 自定义工具                                             |
| ------------------------- | -------------------------------- | ------------------------------------------------------ |
| **工具声明**              | `{"googleSearch": {}}`           | `{"functionDeclarations": [...]}`                      |
| **执行方式**              | API 自动执行                     | 客户端手动执行                                         |
| **响应格式**              | 直接返回文本 + groundingMetadata | 返回 functionCall                                      |
| **需要 functionResponse** | ❌ 不需要                        | ✅ 需要                                                |
| **调用轮次**              | 1 轮                             | 2+ 轮（请求 → functionCall → functionResponse → 答案） |

## 多轮对话格式

### 重要提示：工具声明的持续性

⚠️ **关键区别**：与普通多轮对话不同，**在使用 Google Search 或其他工具时，每次请求都必须包含 `tools` 声明**。

```json
// ✅ 正确：每次请求都包含 tools
{
  "contents": [
    // ... 对话历史
  ],
  "tools": [{"googleSearch": {}}]  // ← 每次都需要
}

// ❌ 错误：后续请求省略 tools
{
  "contents": [
    // ... 对话历史
  ]
  // 缺少 tools 声明！
}
```

**原因**：
Gemini API 是无状态的，不会记忆之前请求中的工具配置。每次请求都是独立的，必须包含完整的上下文（包括工具声明）。

### 基本多轮对话结构

在 `contents` 数组中按顺序添加历史消息，`role` 必须交替出现：

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "第一轮用户消息" }]
		},
		{
			"role": "model",
			"parts": [{ "text": "第一轮模型响应" }]
		},
		{
			"role": "user",
			"parts": [{ "text": "第二轮用户消息" }]
		}
	],
	"tools": [{ "googleSearch": {} }]
}
```

### 完整多轮对话示例

#### 请求示例（第三轮）

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "今天北京的天气怎么样？" }]
		},
		{
			"role": "model",
			"parts": [{ "text": "今天北京天气晴朗，最高温度25度。" }]
		},
		{
			"role": "user",
			"parts": [{ "text": "那明天呢？" }]
		},
		{
			"role": "model",
			"parts": [{ "text": "明天北京预计多云，温度在22-26度。" }]
		},
		{
			"role": "user",
			"parts": [{ "text": "需要带伞吗？" }]
		}
	],
	"tools": [{ "googleSearch": {} }],
	"generationConfig": {
		"temperature": 0,
		"topP": 1
	}
}
```

### 带 groundingMetadata 的多轮对话

当模型响应包含 `groundingMetadata` 时，完整的历史记录应包含该元数据：

```json
{
	"contents": [
		{
			"role": "user",
			"parts": [{ "text": "今天北京的天气怎么样？" }]
		},
		{
			"role": "model",
			"parts": [{ "text": "今天北京天气晴朗，最高温度25度。" }]
			// 注意：groundingMetadata 不需要在历史中保存
		},
		{
			"role": "user",
			"parts": [{ "text": "那明天呢？" }]
		}
	],
	"tools": [{ "googleSearch": {} }]
}
```

### Python 多轮对话实现

```python
import requests

class GeminiChat:
    def __init__(self, api_key: str, model: str = "gemini-2.5-pro"):
        self.api_key = api_key
        self.model = model
        self.url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        self.history = []  # 存储对话历史

    def send_message(self, message: str, use_search: bool = True):
        # 添加用户消息到历史
        self.history.append({
            "role": "user",
            "parts": [{"text": message}]
        })

        # 构建请求
        data = {
            "contents": self.history,
            "generationConfig": {
                "temperature": 0,
                "topP": 1
            }
        }

        # 注意：每次请求都需要包含 tools 声明
        if use_search:
            data["tools"] = [{"googleSearch": {}}]

        # 发送请求
        response = requests.post(
            self.url,
            headers={"Content-Type": "application/json"},
            params={"key": self.api_key},
            json=data
        )

        result = response.json()

        # 提取响应
        if "candidates" in result and len(result["candidates"]) > 0:
            candidate = result["candidates"][0]
            response_text = candidate["content"]["parts"][0]["text"]

            # 添加模型响应到历史（不包含 groundingMetadata）
            self.history.append({
                "role": "model",
                "parts": [{"text": response_text}]
            })

            # 返回响应和来源
            sources = None
            if "groundingMetadata" in candidate:
                sources = candidate["groundingMetadata"].get("groundingChunks", [])

            return {
                "text": response_text,
                "sources": sources
            }
        else:
            raise Exception(f"API 错误: {result}")

    def clear_history(self):
        """清空对话历史"""
        self.history = []

# 使用示例
chat = GeminiChat("YOUR_API_KEY")

# 第一轮
response1 = chat.send_message("今天北京的天气怎么样？")
print(f"AI: {response1['text']}")
if response1['sources']:
    print("\n来源:")
    for i, source in enumerate(response1['sources']):
        print(f"[{i+1}] {source['web']['title']} ({source['web']['uri']})")

# 第二轮（上下文延续）
response2 = chat.send_message("那明天呢？")
print(f"\nAI: {response2['text']}")

# 第三轮
response3 = chat.send_message("需要带伞吗？")
print(f"\nAI: {response3['text']}")
```

### TypeScript 多轮对话实现

```typescript
interface Message {
	role: "user" | "model"
	parts: Array<{ text: string }>
}

interface ChatResponse {
	text: string
	sources?: Array<{
		web: {
			uri: string
			title: string
		}
	}>
}

class GeminiChat {
	private history: Message[] = []
	private url: string

	constructor(
		private apiKey: string,
		private model: string = "gemini-2.5-pro",
	) {
		this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
	}

	async sendMessage(message: string, useSearch: boolean = true): Promise<ChatResponse> {
		// 添加用户消息
		this.history.push({
			role: "user",
			parts: [{ text: message }],
		})

		// 构建请求
		const requestBody: any = {
			contents: this.history,
			generationConfig: {
				temperature: 0,
				topP: 1,
			},
		}

		// 注意：每次请求都需要包含 tools 声明
		if (useSearch) {
			requestBody.tools = [{ googleSearch: {} }]
		}

		// 发送请求
		const response = await fetch(`${this.url}?key=${this.apiKey}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		})

		const result = await response.json()

		if (result.candidates && result.candidates.length > 0) {
			const candidate = result.candidates[0]
			const responseText = candidate.content.parts[0].text

			// 添加模型响应到历史
			this.history.push({
				role: "model",
				parts: [{ text: responseText }],
			})

			return {
				text: responseText,
				sources: candidate.groundingMetadata?.groundingChunks,
			}
		}

		throw new Error(`API Error: ${JSON.stringify(result)}`)
	}

	clearHistory(): void {
		this.history = []
	}

	getHistory(): Message[] {
		return [...this.history]
	}
}

// 使用示例
async function main() {
	const chat = new GeminiChat("YOUR_API_KEY")

	// 第一轮
	const response1 = await chat.sendMessage("今天北京的天气怎么样？")
	console.log("AI:", response1.text)

	// 第二轮（上下文延续）
	const response2 = await chat.sendMessage("那明天呢？")
	console.log("AI:", response2.text)

	// 第三轮
	const response3 = await chat.sendMessage("需要带伞吗？")
	console.log("AI:", response3.text)
}
```

### 多轮对话注意事项

1. **角色交替**：`contents` 数组中的 `role` 必须严格交替（user → model → user → model）
2. **历史管理**：客户端负责维护对话历史，API 不会自动保存
3. **groundingMetadata**：不需要在历史中保存 `groundingMetadata`，只保存 `text` 内容
4. **工具声明持续性**：⚠️ **每次请求都必须包含 `tools` 声明**，即使是后续请求也需要
5. **Token 限制**：注意对话历史的 token 数量，超过限制时需要截断或压缩历史
6. **上下文理解**：模型会根据完整历史理解上下文（如“那明天呢？”会理解为“明天北京的天气”）

### cURL 多轮对话示例

```bash
# 第一轮
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {"role": "user", "parts": [{"text": "今天北京的天气怎么样？"}]}
    ],
    "tools": [{"googleSearch": {}}]
  }'

# 第二轮（包含第一轮历史 + 重新声明 tools）
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {"role": "user", "parts": [{"text": "今天北京的天气怎么样？"}]},
      {"role": "model", "parts": [{"text": "今天北京天气晴朗，最高温度25度。"}]},
      {"role": "user", "parts": [{"text": "那明天呢？"}]}
    ],
    "tools": [{"googleSearch": {}}]
  }'

# 注意：每次请求都必须包含 "tools": [{"googleSearch": {}}]
```

## 错误处理

### 常见错误响应

#### 401 Unauthorized

```json
{
	"error": {
		"code": 401,
		"message": "API key not valid. Please pass a valid API key.",
		"status": "UNAUTHENTICATED"
	}
}
```

#### 429 Too Many Requests

```json
{
	"error": {
		"code": 429,
		"message": "Resource has been exhausted (e.g. check quota).",
		"status": "RESOURCE_EXHAUSTED"
	}
}
```

#### 400 Bad Request

```json
{
	"error": {
		"code": 400,
		"message": "Invalid request",
		"status": "INVALID_ARGUMENT"
	}
}
```

## 相关文件

- `packages/core/src/tools/web-search.ts` - 搜索工具实现
- `packages/core/src/tools/tool-registry.ts` - 工具注册系统
- `packages/core/src/config/config.ts` - 配置和工具初始化
- `packages/core/src/core/client.ts` - Gemini 客户端实现
- `packages/core/src/core/contentGenerator.ts` - 内容生成器
- `integration-tests/google_web_search.test.ts` - 集成测试
- `docs/tools/web-search.md` - 用户文档

## API 文档参考

- [Gemini API - Google Search Grounding](https://ai.google.dev/gemini-api/docs/grounding)
- [Gemini API - Generate Content](https://ai.google.dev/api/generate-content)
- [Gemini API - Authentication](https://ai.google.dev/gemini-api/docs/api-key)
