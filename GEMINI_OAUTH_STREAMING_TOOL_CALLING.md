# Gemini OAuth 流式工具调用 API 文档

本文档详细说明如何通过 OAuth 认证方式使用 Google Code Assist API 实现 Gemini 模型的流式工具调用。

## 📋 目录

- [认证配置](#认证配置)
- [API 端点](#api-端点)
- [流式请求格式](#流式请求格式)
- [流式响应格式](#流式响应格式)
- [工具调用流程](#工具调用流程)
- [完整示例代码](#完整示例代码)
- [错误处理](#错误处理)

---

## 认证配置

### OAuth2 客户端设置

```typescript
import { OAuth2Client } from "google-auth-library"

const oauth2Client = new OAuth2Client({
	clientId: "YOUR_CLIENT_ID",
	clientSecret: "YOUR_CLIENT_SECRET",
	redirectUri: "YOUR_REDIRECT_URI",
})

// 设置访问令牌
oauth2Client.setCredentials({
	access_token: "YOUR_ACCESS_TOKEN",
	refresh_token: "YOUR_REFRESH_TOKEN",
})
```

### 必需的 OAuth Scopes

```
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/cloudcode
```

---

## API 端点

### 基础信息

- **端点**: `https://cloudcode-pa.googleapis.com`
- **API 版本**: `v1internal`
- **流式方法**: `streamGenerateContent`

### 完整 URL

```
POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

---

## 流式请求格式

### HTTP 请求头

```http
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: cloudcode-pa.googleapis.com
Content-Type: application/json
Authorization: Bearer YOUR_ACCESS_TOKEN
User-Agent: YourApp/1.0.0
```

### 请求体结构

```json
{
	"model": "gemini-2.0-flash-exp",
	"project": "your-gcp-project-id",
	"user_prompt_id": "unique-request-id",
	"request": {
		"contents": [
			{
				"role": "user",
				"parts": [
					{
						"text": "Read the file config.json and tell me what's in it"
					}
				]
			}
		],
		"systemInstruction": {
			"role": "user",
			"parts": [
				{
					"text": "You are a helpful assistant with file system access."
				}
			]
		},
		"tools": [
			{
				"functionDeclarations": [
					{
						"name": "read_file",
						"description": "Read the contents of a file",
						"parameters": {
							"type": "object",
							"properties": {
								"path": {
									"type": "string",
									"description": "The file path to read"
								}
							},
							"required": ["path"]
						}
					},
					{
						"name": "write_file",
						"description": "Write content to a file",
						"parameters": {
							"type": "object",
							"properties": {
								"path": {
									"type": "string",
									"description": "The file path to write"
								},
								"content": {
									"type": "string",
									"description": "The content to write"
								}
							},
							"required": ["path", "content"]
						}
					}
				]
			}
		],
		"toolConfig": {
			"functionCallingConfig": {
				"mode": "AUTO"
			}
		},
		"generationConfig": {
			"temperature": 0,
			"topP": 1,
			"maxOutputTokens": 8192,
			"thinkingConfig": {
				"includeThoughts": true
			}
		},
		"session_id": "session-uuid-12345"
	}
}
```

### 关键字段说明

| 字段                       | 类型   | 必需 | 说明                                |
| -------------------------- | ------ | ---- | ----------------------------------- |
| `model`                    | string | ✅   | 模型名称，如 `gemini-2.0-flash-exp` |
| `project`                  | string | ❌   | Google Cloud 项目 ID                |
| `user_prompt_id`           | string | ✅   | 唯一请求标识符                      |
| `request.contents`         | array  | ✅   | 对话历史数组                        |
| `request.tools`            | array  | ❌   | 工具声明数组                        |
| `request.toolConfig`       | object | ❌   | 工具调用配置                        |
| `request.generationConfig` | object | ❌   | 生成参数配置                        |
| `request.session_id`       | string | ❌   | 会话 ID，用于关联多轮对话           |

---

## 流式响应格式

### SSE 流格式

响应采用 Server-Sent Events (SSE) 格式，每个事件以 `data:` 开头：

```
data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"I'll"}]}}]}}

data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" read"}]}}]}}

data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" the"}]}}]}}

data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call-123","name":"read_file","args":{"path":"config.json"}}}]}}]}}

data: {"response":{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":150,"candidatesTokenCount":50,"totalTokenCount":200}}}

```

### 响应对象结构

```typescript
interface StreamResponse {
	response: {
		candidates: Array<{
			content: {
				role: "model"
				parts: Array<
					| { text: string; thought?: boolean }
					| {
							functionCall: {
								id: string
								name: string
								args: Record<string, any>
							}
					  }
				>
			}
			finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER"
			safetyRatings?: Array<{
				category: string
				probability: string
			}>
		}>
		automaticFunctionCallingHistory?: Array<{
			role: "user" | "model"
			parts: any[]
		}>
		usageMetadata?: {
			promptTokenCount: number
			candidatesTokenCount: number
			totalTokenCount: number
			cachedContentTokenCount?: number
		}
	}
}
```

---

## 工具调用流程

### 完整工具调用循环

```
1. 用户发送消息 + 工具声明
   ↓
2. 模型返回 functionCall (流式)
   ↓
3. 客户端执行工具
   ↓
4. 客户端发送 functionResponse
   ↓
5. 模型返回最终答案 (流式)
```

### 步骤 1: 初始请求（带工具声明）

```json
{
	"model": "gemini-2.0-flash-exp",
	"user_prompt_id": "req-001",
	"request": {
		"contents": [
			{
				"role": "user",
				"parts": [{ "text": "Read config.json" }]
			}
		],
		"tools": [
			{
				"functionDeclarations": [
					{
						"name": "read_file",
						"description": "Read a file",
						"parameters": {
							"type": "object",
							"properties": {
								"path": { "type": "string" }
							},
							"required": ["path"]
						}
					}
				]
			}
		]
	}
}
```

### 步骤 2: 模型返回工具调用

流式响应中包含 `functionCall`:

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
								"id": "call-abc123",
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

### 步骤 3: 执行工具并返回结果

```json
{
	"model": "gemini-2.0-flash-exp",
	"user_prompt_id": "req-002",
	"request": {
		"contents": [
			{
				"role": "user",
				"parts": [{ "text": "Read config.json" }]
			},
			{
				"role": "model",
				"parts": [
					{
						"functionCall": {
							"id": "call-abc123",
							"name": "read_file",
							"args": { "path": "config.json" }
						}
					}
				]
			},
			{
				"role": "user",
				"parts": [
					{
						"functionResponse": {
							"id": "call-abc123",
							"name": "read_file",
							"response": {
								"output": "{\"apiKey\": \"xxx\", \"timeout\": 30}"
							}
						}
					}
				]
			}
		],
		"tools": [
			{
				"functionDeclarations": [
					{
						"name": "read_file",
						"description": "Read a file",
						"parameters": {
							"type": "object",
							"properties": {
								"path": { "type": "string" }
							},
							"required": ["path"]
						}
					}
				]
			}
		]
	}
}
```

### 步骤 4: 模型返回最终答案

```json
{
	"response": {
		"candidates": [
			{
				"content": {
					"role": "model",
					"parts": [
						{
							"text": "The config.json file contains an API key and a timeout setting of 30 seconds."
						}
					]
				},
				"finishReason": "STOP"
			}
		],
		"usageMetadata": {
			"totalTokenCount": 250
		}
	}
}
```

---

## 完整示例代码

### TypeScript 实现

```typescript
import { OAuth2Client } from "google-auth-library"
import * as readline from "readline"

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com"
const API_VERSION = "v1internal"

class GeminiStreamingClient {
	constructor(
		private oauth2Client: OAuth2Client,
		private projectId?: string,
	) {}

	async *streamGenerateContent(
		model: string,
		contents: any[],
		tools?: any[],
		sessionId?: string,
	): AsyncGenerator<any> {
		const url = `${CODE_ASSIST_ENDPOINT}/${API_VERSION}:streamGenerateContent`

		const requestBody = {
			model,
			project: this.projectId,
			user_prompt_id: this.generateRequestId(),
			request: {
				contents,
				tools,
				toolConfig: tools
					? {
							functionCallingConfig: { mode: "AUTO" },
						}
					: undefined,
				generationConfig: {
					temperature: 0,
					topP: 1,
				},
				session_id: sessionId,
			},
		}

		const response = await this.oauth2Client.request({
			url,
			method: "POST",
			params: { alt: "sse" },
			headers: {
				"Content-Type": "application/json",
			},
			responseType: "stream",
			body: JSON.stringify(requestBody),
		})

		const rl = readline.createInterface({
			input: response.data as NodeJS.ReadableStream,
			crlfDelay: Infinity,
		})

		let bufferedLines: string[] = []
		for await (const line of rl) {
			if (line === "") {
				if (bufferedLines.length > 0) {
					yield JSON.parse(bufferedLines.join("\n"))
					bufferedLines = []
				}
			} else if (line.startsWith("data: ")) {
				bufferedLines.push(line.slice(6).trim())
			}
		}
	}

	private generateRequestId(): string {
		return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
	}
}

// 使用示例
async function main() {
	const oauth2Client = new OAuth2Client()
	oauth2Client.setCredentials({
		access_token: process.env.ACCESS_TOKEN,
	})

	const client = new GeminiStreamingClient(oauth2Client, "your-project-id")

	// 定义工具
	const tools = [
		{
			functionDeclarations: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
						},
						required: ["path"],
					},
				},
			],
		},
	]

	// 初始对话历史
	let contents = [
		{
			role: "user",
			parts: [{ text: "Read the file config.json" }],
		},
	]

	// 第一轮：获取工具调用
	console.log("=== Round 1: Model requests tool call ===")
	for await (const chunk of client.streamGenerateContent("gemini-2.0-flash-exp", contents, tools)) {
		const candidate = chunk.response?.candidates?.[0]
		if (!candidate) continue

		const parts = candidate.content?.parts || []
		for (const part of parts) {
			if (part.text) {
				process.stdout.write(part.text)
			}
			if (part.functionCall) {
				console.log("\n[Function Call]", JSON.stringify(part.functionCall, null, 2))

				// 添加模型的工具调用到历史
				contents.push({
					role: "model",
					parts: [{ functionCall: part.functionCall }],
				})

				// 执行工具
				const result = await executeTool(part.functionCall.name, part.functionCall.args)

				// 添加工具响应到历史
				contents.push({
					role: "user",
					parts: [
						{
							functionResponse: {
								id: part.functionCall.id,
								name: part.functionCall.name,
								response: { output: result },
							},
						},
					],
				})
			}
		}
	}

	// 第二轮：获取最终答案
	console.log("\n\n=== Round 2: Model provides final answer ===")
	for await (const chunk of client.streamGenerateContent("gemini-2.0-flash-exp", contents, tools)) {
		const candidate = chunk.response?.candidates?.[0]
		if (!candidate) continue

		const parts = candidate.content?.parts || []
		for (const part of parts) {
			if (part.text) {
				process.stdout.write(part.text)
			}
		}

		if (candidate.finishReason) {
			console.log(`\n[Finish: ${candidate.finishReason}]`)
		}
	}
}

// 工具执行函数
async function executeTool(name: string, args: any): Promise<string> {
	console.log(`\n[Executing tool: ${name}]`)

	if (name === "read_file") {
		const fs = await import("fs/promises")
		try {
			const content = await fs.readFile(args.path, "utf-8")
			return content
		} catch (error) {
			return `Error: ${error.message}`
		}
	}

	return "Tool not implemented"
}

main().catch(console.error)
```

### Python 实现

```python
import json
import uuid
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com"
API_VERSION = "v1internal"

class GeminiStreamingClient:
    def __init__(self, credentials: Credentials, project_id: str = None):
        self.credentials = credentials
        self.project_id = project_id

    def stream_generate_content(self, model: str, contents: list, tools: list = None, session_id: str = None):
        import requests

        url = f"{CODE_ASSIST_ENDPOINT}/{API_VERSION}:streamGenerateContent"

        # 刷新令牌
        if not self.credentials.valid:
            self.credentials.refresh(Request())

        headers = {
            "Authorization": f"Bearer {self.credentials.token}",
            "Content-Type": "application/json"
        }

        request_body = {
            "model": model,
            "project": self.project_id,
            "user_prompt_id": str(uuid.uuid4()),
            "request": {
                "contents": contents,
                "tools": tools,
                "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}} if tools else None,
                "generationConfig": {
                    "temperature": 0,
                    "topP": 1
                },
                "session_id": session_id
            }
        }

        response = requests.post(
            url,
            params={"alt": "sse"},
            headers=headers,
            json=request_body,
            stream=True
        )

        response.raise_for_status()

        buffer = []
        for line in response.iter_lines(decode_unicode=True):
            if line == "":
                if buffer:
                    yield json.loads("".join(buffer))
                    buffer = []
            elif line.startswith("data: "):
                buffer.append(line[6:])

# 使用示例
def main():
    credentials = Credentials.from_authorized_user_file('token.json')
    client = GeminiStreamingClient(credentials, 'your-project-id')

    tools = [{
        "functionDeclarations": [{
            "name": "read_file",
            "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"}
                },
                "required": ["path"]
            }
        }]
    }]

    contents = [{
        "role": "user",
        "parts": [{"text": "Read config.json"}]
    }]

    # 第一轮
    for chunk in client.stream_generate_content(
        "gemini-2.0-flash-exp",
        contents,
        tools
    ):
        candidate = chunk.get("response", {}).get("candidates", [{}])[0]
        parts = candidate.get("content", {}).get("parts", [])

        for part in parts:
            if "text" in part:
                print(part["text"], end="", flush=True)
            if "functionCall" in part:
                print(f"\n[Function Call] {json.dumps(part['functionCall'], indent=2)}")

                # 执行工具并添加到历史
                contents.append({"role": "model", "parts": [{"functionCall": part["functionCall"]}]})

                result = execute_tool(part["functionCall"]["name"], part["functionCall"]["args"])

                contents.append({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "id": part["functionCall"]["id"],
                            "name": part["functionCall"]["name"],
                            "response": {"output": result}
                        }
                    }]
                })

    # 第二轮
    print("\n\n=== Final Answer ===")
    for chunk in client.stream_generate_content(
        "gemini-2.0-flash-exp",
        contents,
        tools
    ):
        candidate = chunk.get("response", {}).get("candidates", [{}])[0]
        parts = candidate.get("content", {}).get("parts", [])

        for part in parts:
            if "text" in part:
                print(part["text"], end="", flush=True)

def execute_tool(name: str, args: dict) -> str:
    if name == "read_file":
        try:
            with open(args["path"], "r") as f:
                return f.read()
        except Exception as e:
            return f"Error: {str(e)}"
    return "Tool not implemented"

if __name__ == "__main__":
    main()
```

---

## 错误处理

### 常见错误码

| 状态码 | 错误类型              | 说明                 | 处理方式          |
| ------ | --------------------- | -------------------- | ----------------- |
| 401    | Unauthorized          | OAuth 令牌无效或过期 | 刷新访问令牌      |
| 403    | Forbidden             | 权限不足             | 检查 OAuth scopes |
| 429    | Too Many Requests     | 超出速率限制         | 实现指数退避重试  |
| 500    | Internal Server Error | 服务器错误           | 重试请求          |

### 错误响应示例

```json
{
	"error": {
		"code": 429,
		"message": "Resource has been exhausted (e.g. check quota).",
		"status": "RESOURCE_EXHAUSTED"
	}
}
```

### 重试策略

```typescript
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
	for (let i = 0; i < maxRetries; i++) {
		try {
			return await fn()
		} catch (error: any) {
			const isRetryable = error.status === 429 || error.status >= 500

			if (!isRetryable || i === maxRetries - 1) {
				throw error
			}

			const delay = Math.pow(2, i) * 1000
			await new Promise((resolve) => setTimeout(resolve, delay))
		}
	}
	throw new Error("Max retries exceeded")
}
```

---

## 最佳实践

### 1. 会话管理

使用 `session_id` 关联同一会话的多个请求：

```typescript
const sessionId = `session-${Date.now()}`

// 所有请求使用相同的 session_id
await client.streamGenerateContent(model, contents, tools, sessionId)
```

### 2. 工具声明优化

- 提供清晰的描述
- 使用 JSON Schema 严格定义参数
- 标记必需参数

```json
{
	"name": "search_database",
	"description": "Search the user database by name or email. Returns user details including ID, name, email, and registration date.",
	"parameters": {
		"type": "object",
		"properties": {
			"query": {
				"type": "string",
				"description": "The search query (name or email)"
			},
			"limit": {
				"type": "integer",
				"description": "Maximum number of results to return",
				"default": 10
			}
		},
		"required": ["query"]
	}
}
```

### 3. 流式处理

逐块处理响应以提供实时反馈：

```typescript
let fullText = ""
for await (const chunk of stream) {
	const text = chunk.response?.candidates?.[0]?.content?.parts?.[0]?.text
	if (text) {
		fullText += text
		process.stdout.write(text) // 实时输出
	}
}
```

### 4. 错误恢复

保存对话历史以便在错误后恢复：

```typescript
const conversationHistory = []

try {
	for await (const chunk of stream) {
		// 处理响应
	}
} catch (error) {
	console.error("Stream error:", error)
	// 使用 conversationHistory 重试
}
```

---

## 附录

### A. 支持的模型

- `gemini-2.0-flash-exp`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-1.5-pro`
- `gemini-1.5-flash`

### B. 工具调用模式

| 模式   | 说明                     |
| ------ | ------------------------ |
| `AUTO` | 模型自动决定是否调用工具 |
| `ANY`  | 模型必须调用至少一个工具 |
| `NONE` | 禁用工具调用             |

### C. 完成原因

| finishReason | 说明                |
| ------------ | ------------------- |
| `STOP`       | 正常完成            |
| `MAX_TOKENS` | 达到最大 token 限制 |
| `SAFETY`     | 安全过滤器触发      |
| `RECITATION` | 检测到重复内容      |
| `OTHER`      | 其他原因            |

---

## 参考资源

- [Google OAuth 2.0 文档](https://developers.google.com/identity/protocols/oauth2)
- [Gemini API 官方文档](https://ai.google.dev/docs)
- [Function Calling 指南](https://ai.google.dev/docs/function_calling)

---

**文档版本**: 1.0.0  
**最后更新**: 2025-01-20  
**适用于**: Code Assist API v1internal
