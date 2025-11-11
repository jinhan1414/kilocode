import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import type { ToolUseStyle } from "@roo-code/types"
import { consolidateReasoningDetails, ReasoningDetail } from "./kilocode/reasoning-details"

export function convertToOpenAiMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	toolStyle?: ToolUseStyle,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []
	// kilocode_change: Track tool_use_ids from assistant messages to validate tool results
	const validToolUseIds = new Set<string>()

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			openAiMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content })
		} else {
			// image_url.url is base64 encoded image data
			// ensure it contains the content-type of the image: data:image/png;base64,
			/*
        { role: "user", content: "" | { type: "text", text: string } | { type: "image_url", image_url: { url: string } } },
         // content required unless tool_calls is present
        { role: "assistant", content?: "" | null, tool_calls?: [{ id: "", function: { name: "", arguments: "" }, type: "function" }] },
        { role: "tool", tool_call_id: "", content: ""}
         */
			if (anthropicMessage.role === "user") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolResultBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						} // user cannot send tool_use messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process tool result messages FIRST since they must follow the tool use messages
				let toolResultImages: Anthropic.Messages.ImageBlockParam[] = []

				if (toolStyle === "xml") {
					// In XML mode, convert tool results to text format
					toolMessages.forEach((toolMessage) => {
						let content: string
						if (typeof toolMessage.content === "string") {
							content = toolMessage.content
						} else {
							content =
								toolMessage.content
									?.map((part) => {
										if (part.type === "image") {
											toolResultImages.push(part)
											return "(see following user message for image)"
										}
										return part.text
									})
									.join("\n") ?? ""
						}

						// Add tool result as text in XML format
						const toolName = (toolMessage as any).tool_name || "tool"
						nonToolMessages.push({
							type: "text",
							text: `[${toolName} Result]\n\n${content}`,
						})
					})
				} else {
					// In JSON mode (or default), use native tool format
					// kilocode_change start: Deduplicate tool results by tool_use_id to prevent duplicate tool messages
					const seenToolUseIds = new Set<string>()

					toolMessages.forEach((toolMessage) => {
						// Skip duplicate tool_use_id to prevent duplicate tool messages
						if (seenToolUseIds.has(toolMessage.tool_use_id)) {
							console.warn(
								`[convertToOpenAiMessages] Skipping duplicate tool result for tool_use_id: ${toolMessage.tool_use_id}`,
							)
							return
						}
						// kilocode_change: Skip orphaned tool results (missing corresponding tool_use)
						if (!validToolUseIds.has(toolMessage.tool_use_id)) {
							console.warn(
								`[convertToOpenAiMessages] Skipping orphaned tool result for tool_use_id: ${toolMessage.tool_use_id} (no matching tool_use found in conversation history)`,
							)
							return
						}
						seenToolUseIds.add(toolMessage.tool_use_id)
						// kilocode_change end

						let content: string

						if (typeof toolMessage.content === "string") {
							content = toolMessage.content
						} else {
							content =
								toolMessage.content
									?.map((part) => {
										if (part.type === "image") {
											toolResultImages.push(part)
											return "(see following user message for image)"
										}
										return part.text
									})
									.join("\n") ?? ""
						}
						openAiMessages.push({
							role: "tool",
							tool_call_id: toolMessage.tool_use_id,
							content: content,
						})
					})
				}

				// If tool results contain images, send as a separate user message
				// I ran into an issue where if I gave feedback for one of many tool uses, the request would fail.
				// "Messages following `tool_use` blocks must begin with a matching number of `tool_result` blocks."
				// Therefore we need to send these images after the tool result messages
				// NOTE: it's actually okay to have multiple user messages in a row, the model will treat them as a continuation of the same input (this way works better than combining them into one message, since the tool result specifically mentions (see following user message for image)
				// UPDATE v2.0: we don't use tools anymore, but if we did it's important to note that the openrouter prompt caching mechanism requires one user message at a time, so we would need to add these images to the user content array instead.
				// if (toolResultImages.length > 0) {
				// 	openAiMessages.push({
				// 		role: "user",
				// 		content: toolResultImages.map((part) => ({
				// 			type: "image_url",
				// 			image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
				// 		})),
				// 	})
				// }

				// Process non-tool messages
				if (nonToolMessages.length > 0) {
					openAiMessages.push({
						role: "user",
						content: nonToolMessages.map((part) => {
							if (part.type === "image") {
								return {
									type: "image_url",
									image_url: {
										// kilocode_change begin support type==url
										url:
											part.source.type === "url"
												? part.source.url
												: `data:${part.source.media_type};base64,${part.source.data}`,
										// kilocode_change end
									},
								}
							}
							return { type: "text", text: part.text }
						}),
					})
				}
			} else if (anthropicMessage.role === "assistant") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolUseBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_use") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						} // assistant cannot send tool_result messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process non-tool messages and tool use messages
				if (toolStyle === "xml") {
					// In XML mode, convert tool_use to text format
					let allContent: string[] = []
					const reasoningDetails = new Array<ReasoningDetail>() // kilocode_change

					if (nonToolMessages.length > 0) {
						// kilocode_change start
						nonToolMessages.forEach((part) => {
							if (part.type === "text" && "reasoning_details" in part && part.reasoning_details) {
								if (Array.isArray(part.reasoning_details)) {
									reasoningDetails.push(...part.reasoning_details)
								} else {
									reasoningDetails.push(part.reasoning_details as ReasoningDetail)
								}
							}
						})
						// kilocode_change end
						allContent.push(
							nonToolMessages
								.map((part) => {
									if (part.type === "image") {
										return "" // impossible as the assistant cannot send images
									}
									return part.text
								})
								.join("\n"),
						)
					}

					toolMessages.forEach((toolMessage) => {
						const inputAsXml = Object.entries(toolMessage.input as Record<string, unknown>)
							.map(
								([key, value]) =>
									`<${key}>\n${typeof value === "string" ? value : JSON.stringify(value)}\n</${key}>`,
							)
							.join("\n")
						allContent.push(`<${toolMessage.name}>\n${inputAsXml}\n</${toolMessage.name}>`)
					})

					openAiMessages.push({
						role: "assistant",
						content: allContent.join("\n"),
					})
				} else {
					// In JSON mode (or default), use native tool format
					let content: string | undefined
					const reasoningDetails = new Array<ReasoningDetail>() // kilocode_change

					if (nonToolMessages.length > 0) {
						// kilocode_change start
						nonToolMessages.forEach((part) => {
							if (part.type === "text" && "reasoning_details" in part && part.reasoning_details) {
								if (Array.isArray(part.reasoning_details)) {
									reasoningDetails.push(...part.reasoning_details)
								} else {
									reasoningDetails.push(part.reasoning_details as ReasoningDetail)
								}
							}
						})
						// kilocode_change end
						content = nonToolMessages
							.map((part) => {
								if (part.type === "image") {
									return "" // impossible as the assistant cannot send images
								}
								return part.text
							})
							.join("\n")
					}

					// Process tool use messages
					// kilocode_change: Track valid tool_use_ids for later validation
					let tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolMessages.map((toolMessage) => {
						validToolUseIds.add(toolMessage.id)
						return {
							id: toolMessage.id,
							type: "function",
							function: {
								name: toolMessage.name,
								// json string
								arguments: JSON.stringify(toolMessage.input),
							},
						}
					})

					openAiMessages.push({
						role: "assistant",
						content,
						// Cannot be an empty array. API expects an array with minimum length 1, and will respond with an error if it's empty
						tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
						// kilocode_change start
						// @ts-ignore-next-line: property is OpenRouter-specific
						reasoning_details:
							reasoningDetails.length > 0 ? consolidateReasoningDetails(reasoningDetails) : undefined,
						// kilocode_change end
					})
				}
			}
		}
	}

	return openAiMessages
}
