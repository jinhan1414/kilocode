import type { Anthropic } from "@anthropic-ai/sdk"
import { OAuth2Client } from "google-auth-library"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import axios from "axios"
import dotenvx from "@dotenvx/dotenvx"
import OpenAI from "openai"

import {
	type ModelInfo,
	type GeminiCliModelId,
	geminiCliDefaultModelId,
	geminiCliModels,
	getActiveToolUseStyle,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { t } from "../../i18n"

import { convertAnthropicContentToGemini, convertAnthropicMessageToGemini } from "../transform/gemini-format"
import type { ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"

// OAuth2 Configuration (from Cline implementation)
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
const OAUTH_CLIENT_SECRET = "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"
const OAUTH_REDIRECT_URI = "http://localhost:45289"

// Code Assist API Configuration
// const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com"
// const CODE_ASSIST_ENDPOINT = "https://gemini-cli.141464.xyz"
const CODE_ASSIST_ENDPOINT = "https://denoproxy.141464.xyz/https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_API_VERSION = "v1internal"

interface OAuthCredentials {
	access_token: string
	refresh_token: string
	token_type: string
	expiry_date: number
	projectId?: string
	name?: string
}

export class GeminiCliHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private authClient: OAuth2Client
	private projectId: string | null = null
	private credentials: OAuthCredentials[] | null = null
	private isMultiCredential = false

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.options.geminiCliCredentialIndex = this.options.geminiCliCredentialIndex ?? 0

		// Initialize OAuth2 client
		this.authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI)
	}

	private async selectNextCredential(): Promise<void> {
		if (!this.isMultiCredential) {
			throw new Error(t("common:errors.geminiCli.singleCredentialFailed"))
		}

		this.options.geminiCliCredentialIndex!++

		// If we've cycled through all credentials, throw an error
		if (this.options.geminiCliCredentialIndex! >= this.credentials!.length) {
			this.options.geminiCliCredentialIndex = 0 // Reset for future attempts
			throw new Error(t("common:errors.geminiCli.allCredentialsFailed"))
		}

		// Set the new credential on the auth client
		const newCredential = this.credentials![this.options.geminiCliCredentialIndex!]
		this.authClient.setCredentials({
			access_token: newCredential.access_token,
			refresh_token: newCredential.refresh_token,
			expiry_date: newCredential.expiry_date,
		})

		// Update projectId if it's part of the credential
		this.projectId = newCredential.projectId || null
	}

	private async loadOAuthCredentials(): Promise<void> {
		try {
			const credPath = this.options.geminiCliOAuthPath || path.join(os.homedir(), ".gemini", "oauth_creds.json")
			const credData = await fs.readFile(credPath, "utf-8")
			const parsedData = JSON.parse(credData)

			if (Array.isArray(parsedData)) {
				this.credentials = parsedData
				this.isMultiCredential = true
			} else {
				this.credentials = [parsedData]
				this.isMultiCredential = false
			}

			if (!this.credentials || this.credentials.length === 0) {
				throw new Error("No credentials found.")
			}

			// Set initial credentials on the OAuth2 client
			if (this.options.geminiCliCredentialIndex! >= this.credentials.length) {
				this.options.geminiCliCredentialIndex = 0
			}
			const initialCredential = this.credentials[this.options.geminiCliCredentialIndex!]
			this.authClient.setCredentials({
				access_token: initialCredential.access_token,
				refresh_token: initialCredential.refresh_token,
				expiry_date: initialCredential.expiry_date,
			})

			// Set initial projectId if available
			this.projectId = initialCredential.projectId || null
		} catch (error) {
			throw new Error(t("common:errors.geminiCli.oauthLoadFailed", { error }))
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.credentials) {
			await this.loadOAuthCredentials()
		}

		const currentCredential = this.credentials![this.options.geminiCliCredentialIndex!]

		// Check if token needs refresh
		if (currentCredential.expiry_date < Date.now()) {
			try {
				const { credentials: refreshed } = await this.authClient.refreshAccessToken()
				if (refreshed.access_token) {
					const updatedCredential = {
						...currentCredential,
						access_token: refreshed.access_token,
						refresh_token: refreshed.refresh_token || currentCredential.refresh_token,
						token_type: refreshed.token_type || "Bearer",
						expiry_date: refreshed.expiry_date || Date.now() + 3600 * 1000,
					}
					this.credentials![this.options.geminiCliCredentialIndex!] = updatedCredential

					// Save refreshed credentials back to file
					const credPath =
						this.options.geminiCliOAuthPath || path.join(os.homedir(), ".gemini", "oauth_creds.json")

					// Write back the correct format (array or single object)
					const dataToWrite = this.isMultiCredential ? this.credentials : this.credentials![0]
					await fs.writeFile(credPath, JSON.stringify(dataToWrite, null, 2))
				}
			} catch (error) {
				throw new Error(t("common:errors.geminiCli.tokenRefreshFailed", { error }))
			}
		}
	}

	/**
	 * Call a Code Assist API endpoint
	 */
	private async callEndpoint(method: string, body: any, retry: boolean = true): Promise<any> {
		await this.ensureAuthenticated()

		try {
			const res = await this.authClient.request({
				url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				responseType: "json",
				data: JSON.stringify(body),
			})
			return res.data
		} catch (error: any) {
			const currentCredential = this.credentials![this.options.geminiCliCredentialIndex!]
			const credName = currentCredential.name || "Unnamed"
			const credProjectId = currentCredential.projectId || "N/A"
			console.error(
				`[GeminiCLI] Error calling ${method} with credential #${this.options.geminiCliCredentialIndex} (Name: ${credName}, ProjectID: ${credProjectId}):`,
				error.message,
			)

			if (
				retry &&
				(error.response?.status === 403 || error.response?.status === 401 || error.response?.status === 429)
			) {
				try {
					await this.selectNextCredential()
					return this.callEndpoint(method, body, true)
				} catch (switchError: any) {
					throw new Error(t("common:errors.geminiCli.allCredentialsFailed"))
				}
			}
			throw error
		}
	}

	private async callStreamingEndpoint(method: string, body: any): Promise<NodeJS.ReadableStream> {
		await this.ensureAuthenticated()
		try {
			const requestInfo = {
				timestamp: new Date().toISOString(),
				method,
				url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
				body,
			}
			await fs.appendFile("D:\\cli.log", JSON.stringify(requestInfo, null, 2) + "\n\n").catch(() => {})
			const response = await this.authClient.request({
				url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
				method: "POST",
				params: { alt: "sse" },
				headers: { "Content-Type": "application/json" },
				responseType: "stream",
				data: JSON.stringify(body),
			})
			return response.data as NodeJS.ReadableStream
		} catch (error: any) {
			const currentCredential = this.credentials![this.options.geminiCliCredentialIndex!]
			const credName = currentCredential.name || "Unnamed"
			const credProjectId = currentCredential.projectId || "N/A"
			console.error(
				`[GeminiCLI] Error calling streaming ${method} with credential #${this.options.geminiCliCredentialIndex} (Name: ${credName}, ProjectID: ${credProjectId}):`,
				error.message,
			)

			throw error
		}
	}

	/**
	 * Discover or retrieve the project ID
	 */
	private async discoverProjectId(): Promise<string> {
		// 1. Prioritize projectId from the current credential
		if (this.projectId) {
			return this.projectId
		}

		// 2. Fallback to projectId from options
		if (this.options.geminiCliProjectId) {
			this.projectId = this.options.geminiCliProjectId
			return this.projectId
		}

		// 3. If we've already discovered it in this session, return it
		// This check is slightly redundant due to the first check, but safe to keep.
		if (this.projectId) {
			return this.projectId
		}

		// 4. Discover from environment or API
		// Lookup for the project id from the env variable
		// with a fallback to a default project ID (can be anything for personal OAuth)
		const envPath = this.options.geminiCliOAuthPath || path.join(os.homedir(), ".gemini", ".env")

		const { parsed, error } = dotenvx.config({ path: envPath, override: true })

		if (error) {
			console.warn("[GeminiCLI] .env file not found or invalid format, proceeding with default project ID")
		}

		// If the project ID was in the .env file, use it and return early.
		if (parsed?.GOOGLE_CLOUD_PROJECT) {
			this.projectId = parsed.GOOGLE_CLOUD_PROJECT
			return this.projectId
		}

		const initialProjectId = process.env.GOOGLE_CLOUD_PROJECT ?? "default"

		// Prepare client metadata
		const clientMetadata = {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
			duetProject: initialProjectId,
		}

		try {
			// Call loadCodeAssist to discover the actual project ID
			const loadRequest = {
				cloudaicompanionProject: initialProjectId,
				metadata: clientMetadata,
			}

			const loadResponse = await this.callEndpoint("loadCodeAssist", loadRequest)

			// Check if we already have a project ID from the response
			if (loadResponse.cloudaicompanionProject) {
				this.projectId = loadResponse.cloudaicompanionProject
				return this.projectId as string
			}

			// If no existing project, we need to onboard
			const defaultTier = loadResponse.allowedTiers?.find((tier: any) => tier.isDefault)
			const tierId = defaultTier?.id || "free-tier"

			const onboardRequest = {
				tierId: tierId,
				cloudaicompanionProject: initialProjectId,
				metadata: clientMetadata,
			}

			let lroResponse = await this.callEndpoint("onboardUser", onboardRequest)

			// Poll until operation is complete with timeout protection
			const MAX_RETRIES = 30 // Maximum number of retries (60 seconds total)
			let retryCount = 0

			while (!lroResponse.done && retryCount < MAX_RETRIES) {
				await new Promise((resolve) => setTimeout(resolve, 2000))
				lroResponse = await this.callEndpoint("onboardUser", onboardRequest)
				retryCount++
			}

			if (!lroResponse.done) {
				throw new Error(t("common:errors.geminiCli.onboardingTimeout"))
			}

			const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId
			this.projectId = discoveredProjectId
			return this.projectId as string
		} catch (error: any) {
			console.error("Failed to discover project ID:", error.response?.data || error.message)
			throw new Error(t("common:errors.geminiCli.projectDiscoveryFailed"))
		}
	}

	/**
	 * Parse Server-Sent Events from a stream
	 */
	private async *parseSSEStream(stream: NodeJS.ReadableStream): AsyncGenerator<any> {
		let buffer = ""

		for await (const chunk of stream) {
			buffer += chunk.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const data = line.slice(6).trim()
					if (data === "[DONE]") continue

					try {
						const parsed = JSON.parse(data)
						await fs.appendFile("D:\\cli.log", `RESPONSE: ${JSON.stringify(parsed)}\n`).catch(() => {})
						yield parsed
					} catch (e) {
						console.error("Error parsing SSE data:", e)
					}
				}
			}
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.ensureAuthenticated()
		const { id: model, info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		const toolStyle = getActiveToolUseStyle(this.options)
		const contents = messages.map((msg) => convertAnthropicMessageToGemini(msg, toolStyle))

		// Use a recursive generator to handle retries
		yield* this._createMessageRecursive(systemInstruction, contents, model, maxTokens, thinkingConfig, metadata)
	}

	private async *_createMessageRecursive(
		systemInstruction: string,
		contents: any[],
		model: string,
		maxTokens: number | undefined,
		thinkingConfig: any,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		try {
			const projectId = await this.discoverProjectId()

			const requestBody: any = {
				model: model,
				project: projectId,
				request: {
					contents: contents,
					systemInstruction: {
						role: "user",
						parts: [{ text: systemInstruction }],
					},
					generationConfig: {
						temperature: this.options.modelTemperature ?? 0.7,
						maxOutputTokens: this.options.modelMaxTokens ?? maxTokens ?? 8192,
					},
				},
			}

			if (thinkingConfig) {
				requestBody.request.generationConfig.thinkingConfig = thinkingConfig
			}

			// kilocode_change start: Add native tool call support when toolStyle is "json"
			// When using xml tool style, don't pass tools to the API
			// The tool definitions will be in the system prompt instead
			const toolUseStyle = getActiveToolUseStyle(this.options)
			if (toolUseStyle === "json" && metadata?.allowedTools) {
				await fs
					.appendFile(
						"D:\\cli.log",
						`\nCONVERT_INPUT: ${JSON.stringify({ messages: contents, allowedTools: metadata.allowedTools })}\n`,
					)
					.catch(() => {})
				const geminiTools = this.convertOpenAIToolsToGemini(metadata.allowedTools)

				// Add google_web_search as a function declaration
				if (geminiTools[0]?.functionDeclarations) {
					geminiTools[0].functionDeclarations.push({
						name: "google_web_search",
						description:
							"Performs a web search using Google Search. Use this to find current information on the web.",
						parameters: {
							type: "object",
							properties: {
								query: {
									type: "string",
									description: "The search query to find information on the web",
								},
							},
							required: ["query"],
						},
					})
				}

				await fs.appendFile("D:\\cli.log", `CONVERT_OUTPUT: ${JSON.stringify(geminiTools)}\n\n`).catch(() => {})
				if (geminiTools[0]?.functionDeclarations?.length > 0) {
					requestBody.request.tools = geminiTools
					requestBody.request.toolConfig = {
						functionCallingConfig: { mode: "ANY" },
					}
				}
			} else if (toolUseStyle === "xml") {
				// For xml tool style, don't add any tools to the request
				// The tool definitions will be in the system prompt
			} else {
				// Enable Google Search only when no custom tools
				requestBody.request.tools = [{ googleSearch: {} }]
			}
			// kilocode_change end

			// Log the complete request body including tools
			await fs
				.appendFile("D:\\cli.log", `\nFINAL_REQUEST: ${JSON.stringify(requestBody, null, 2)}\n\n`)
				.catch(() => {})

			const currentCredential = this.credentials![this.options.geminiCliCredentialIndex!]
			const credName = currentCredential.name || "Unnamed"
			const credProjectId = currentCredential.projectId || "N/A"
			console.debug(
				`[GeminiCLI]  calling streaming  with credential #${this.options.geminiCliCredentialIndex} (Name: ${credName}, ProjectID: ${credProjectId}):`,
			)

			const stream = await this.callStreamingEndpoint("streamGenerateContent", requestBody)

			// Process the SSE stream
			let lastUsageMetadata: any = undefined
			let groundingMetadata: any = undefined

			for await (const jsonData of this.parseSSEStream(stream)) {
				// Extract content from the response
				const responseData = jsonData.response || jsonData
				const candidate = responseData.candidates?.[0]

				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text) {
							if (part.thought === true) {
								yield {
									type: "reasoning",
									text: part.text,
								}
							} else {
								yield {
									type: "text",
									text: part.text,
								}
							}
						}
						// kilocode_change start: Handle native tool calls when toolStyle is "json"
						// Only process native tool calls when toolStyle is "json"
						if (part.functionCall) {
							const toolStyle = getActiveToolUseStyle(this.options)
							if (toolStyle === "json") {
								// Handle google_web_search internally
								if (part.functionCall.name === "google_web_search") {
									const query = part.functionCall.args?.query
									if (query) {
										// Execute search with separate API call
										const searchBody: any = {
											model,
											project: projectId,
											request: {
												contents: [{ role: "user", parts: [{ text: query }] }],
												tools: [{ googleSearch: {} }],
											},
										}
										const searchResp = await this.callEndpoint("generateContent", searchBody)
										const searchData = searchResp.response || searchResp
										const searchCandidate = searchData.candidates?.[0]

										let searchResult = ""
										if (searchCandidate?.content?.parts) {
											for (const p of searchCandidate.content.parts) {
												if (p.text) searchResult += p.text
											}
										}
										if (searchCandidate?.groundingMetadata?.groundingChunks) {
											const sources = searchCandidate.groundingMetadata.groundingChunks
												.map(
													(c: any, i: number) =>
														`[${i + 1}] ${c.web?.title || ""} (${c.web?.uri || ""})`,
												)
												.join("\n")
											searchResult += `\n\nSources:\n${sources}`
										}

										// Add search result to contents and continue
										contents.push(
											{
												role: "model",
												parts: [
													{ functionCall: { name: "google_web_search", args: { query } } },
												],
											},
											{
												role: "user",
												parts: [
													{
														functionResponse: {
															name: "google_web_search",
															response: { result: searchResult },
														},
													},
												],
											},
										)

										// Recursively continue conversation
										yield* this._createMessageRecursive(
											systemInstruction,
											contents,
											model,
											maxTokens,
											thinkingConfig,
											metadata,
										)
										return
									}
								}

								const toolCallId =
									part.functionCall.id || `toolu_${part.functionCall.name}_${Date.now()}`
								yield {
									type: "native_tool_calls",
									toolCalls: [
										{
											id: toolCallId,
											type: "function",
											function: {
												name: part.functionCall.name,
												arguments: JSON.stringify(part.functionCall.args || {}),
											},
										},
									],
								}
							} else if (toolStyle === "xml") {
								// When toolStyle is xml, function calls shouldn't occur from the API
								// Log a warning if they do
								console.warn(
									"[GeminiCLI] Received function call but toolStyle is 'xml'. Ignoring.",
									part.functionCall,
								)
							}
						}
						// kilocode_change end
					}
				}

				// Store grounding metadata from Google Search
				if (candidate?.groundingMetadata) {
					groundingMetadata = candidate.groundingMetadata
				}

				// Store usage metadata for final reporting
				if (responseData.usageMetadata) {
					lastUsageMetadata = responseData.usageMetadata
				}

				// Check if this is the final chunk
				if (candidate?.finishReason) {
					break
				}
			}

			// Output Google Search sources if available
			if (groundingMetadata?.groundingChunks?.length > 0) {
				const sources = groundingMetadata.groundingChunks
					.map((chunk: any, index: number) => {
						const title = chunk.web?.title || "Untitled"
						const uri = chunk.web?.uri || ""
						return `[${index + 1}] ${title} (${uri})`
					})
					.join("\n")

				yield {
					type: "text",
					text: `\n\nSources:\n${sources}`,
				}
			}

			// Yield final usage information
			if (lastUsageMetadata) {
				const inputTokens = lastUsageMetadata.promptTokenCount ?? 0
				const outputTokens = lastUsageMetadata.candidatesTokenCount ?? 0
				const cacheReadTokens = lastUsageMetadata.cachedContentTokenCount
				const reasoningTokens = lastUsageMetadata.thoughtsTokenCount

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
					cacheReadTokens,
					reasoningTokens,
					totalCost: 0, // Free tier - all costs are 0
				}
			}
		} catch (error: any) {
			if (error.response?.status === 403 || error.response?.status === 401 || error.response?.status === 429) {
				try {
					await this.selectNextCredential()
					// Recursively call to retry
					yield* this._createMessageRecursive(
						systemInstruction,
						contents,
						model,
						maxTokens,
						thinkingConfig,
						metadata,
					)
				} catch (switchError: any) {
					// All credentials failed
					throw new Error(t("common:errors.geminiCli.allCredentialsFailed"))
				}
			} else {
				// For other errors, rethrow them
				console.error("[GeminiCLI] Error in createMessage:", error)
				if (error.response?.status === 400) {
					throw new Error(
						t("common:errors.geminiCli.badRequest", {
							details: JSON.stringify(error.response?.data) || error.message,
						}),
					)
				}
				throw error
			}
		}
	}

	override getModel() {
		const modelId = this.options.apiModelId
		// Handle :thinking suffix before checking if model exists
		const baseModelId = modelId?.endsWith(":thinking") ? modelId.replace(":thinking", "") : modelId
		let id =
			baseModelId && baseModelId in geminiCliModels ? (baseModelId as GeminiCliModelId) : geminiCliDefaultModelId
		const info: ModelInfo = geminiCliModels[id]
		const params = getModelParams({ format: "gemini", modelId: id, model: info, settings: this.options })

		// Return the cleaned model ID
		return { id, info, ...params }
	}

	async completePrompt(prompt: string): Promise<string> {
		await this.ensureAuthenticated()
		const projectId = await this.discoverProjectId()

		try {
			const { id: model } = this.getModel()

			const requestBody = {
				model: model,
				project: projectId,
				request: {
					contents: [{ role: "user", parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: this.options.modelTemperature ?? 0.7,
					},
				},
			}

			const response = await this.callEndpoint("generateContent", requestBody)

			// Extract text from response, handling both direct and nested response structures
			const responseData = response.response || response

			if (responseData.candidates && responseData.candidates.length > 0) {
				const candidate = responseData.candidates[0]
				if (candidate.content && candidate.content.parts) {
					const textParts = candidate.content.parts
						.filter((part: any) => part.text && !part.thought)
						.map((part: any) => part.text)
						.join("")
					return textParts
				}
			}

			return ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(t("common:errors.geminiCli.completionError", { error: error.message }))
			}
			throw error
		}
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// For OAuth/free tier, we can't use the token counting API
		// Fall back to the base provider's tiktoken implementation
		return super.countTokens(content)
	}

	// kilocode_change start: Convert OpenAI tool format to Gemini format
	private convertOpenAIToolsToGemini(tools: OpenAI.Chat.ChatCompletionTool[]): any[] {
		return [
			{
				functionDeclarations: tools
					.filter((tool) => "function" in tool && tool.function !== undefined)
					.map((tool) => {
						const func = (tool as any).function
						return {
							name: func.name,
							description: func.description || "",
							parameters: this.convertJsonSchemaToGemini(func.parameters),
						}
					}),
			},
		]
	}

	/**
	 * Convert JSON Schema to Gemini's Proto-compatible format
	 * Handles union types by extracting the non-null type
	 */
	private convertJsonSchemaToGemini(schema: any): any {
		if (!schema || typeof schema !== "object") {
			return {}
		}

		const result: any = {}

		// Handle type: convert arrays to single type (remove null)
		if (schema.type) {
			if (Array.isArray(schema.type)) {
				const nonNullType = schema.type.find((t: string) => t !== "null")
				if (nonNullType) result.type = nonNullType
			} else {
				result.type = schema.type
			}
		}

		if (schema.description) result.description = schema.description
		if (schema.required) result.required = schema.required
		if (schema.enum) result.enum = schema.enum

		if (schema.properties) {
			result.properties = {}
			for (const [key, prop] of Object.entries(schema.properties)) {
				result.properties[key] = this.convertJsonSchemaToGemini(prop)
			}
		}

		if (schema.items) {
			result.items = this.convertJsonSchemaToGemini(schema.items)
		}

		return result
	}
	// kilocode_change end
}
