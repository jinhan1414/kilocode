import { Anthropic } from "@anthropic-ai/sdk"
import { Content, Part } from "@google/genai"
import type { ToolUseStyle } from "@roo-code/types"

export function convertAnthropicContentToGemini(
	content: string | Anthropic.ContentBlockParam[],
	toolStyle?: ToolUseStyle,
): Part[] {
	if (typeof content === "string") {
		return [{ text: content }]
	}

	const parts = content.flatMap((block): Part | Part[] => {
		switch (block.type) {
			case "text":
				// Filter out empty text blocks
				if (!block.text || block.text.trim() === "") {
					return []
				}
				return { text: block.text }
			case "image":
				if (block.source.type !== "base64") {
					throw new Error("Unsupported image source type")
				}

				return { inlineData: { data: block.source.data, mimeType: block.source.media_type } }
			case "tool_use":
				// In XML mode, convert tool_use to text format
				if (toolStyle === "xml") {
					const inputAsXml = Object.entries(block.input as Record<string, unknown>)
						.map(
							([key, value]) =>
								`<${key}>\n${typeof value === "string" ? value : JSON.stringify(value)}\n</${key}>`,
						)
						.join("\n")
					return {
						text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
					}
				}
				// In JSON mode, use native function call format
				return {
					functionCall: {
						id: block.id,
						name: block.name,
						args: block.input as Record<string, unknown>,
					},
				}
			case "tool_result": {
				if (!block.content) {
					return []
				}

				// Extract text content from block
				let textContent: string
				const imageParts: Part[] = []

				if (typeof block.content === "string") {
					textContent = block.content
				} else if (Array.isArray(block.content)) {
					const textParts: string[] = []
					for (const item of block.content) {
						if (item.type === "text") {
							textParts.push(item.text)
						} else if (item.type === "image" && item.source.type === "base64") {
							const { data, media_type } = item.source
							imageParts.push({ inlineData: { data, mimeType: media_type } })
						}
					}
					textContent = textParts.join("\n\n")
				} else {
					return []
				}

				// In XML mode, convert tool_result to text format
				if (toolStyle === "xml") {
					const toolName = (block as any).tool_name || "tool"
					const resultText = `[${toolName} Result]\n\n${textContent}`
					return imageParts.length > 0 ? [{ text: resultText }, ...imageParts] : [{ text: resultText }]
				}

				// In JSON mode, use native function response format
				const toolName = (block as any).tool_name || block.tool_use_id
				const contentText = textContent + (imageParts.length > 0 ? "\n\n(See next part for image)" : "")

				return [
					{ functionResponse: { id: block.tool_use_id, name: toolName, response: { output: contentText } } },
					...imageParts,
				]
			}
			default:
				// Currently unsupported: "thinking" | "redacted_thinking" | "document"
				throw new Error(`Unsupported content block type: ${block.type}`)
		}
	})

	// If all parts were filtered out (e.g., only empty text), return empty array
	// This is valid for Gemini when there's only a functionCall in the original message
	return parts
}

export function convertAnthropicMessageToGemini(
	message: Anthropic.Messages.MessageParam,
	toolStyle?: ToolUseStyle,
): Content {
	const parts = convertAnthropicContentToGemini(message.content, toolStyle)

	// Gemini API requires at least one part in the message
	// If parts array is empty, add a placeholder text part
	if (parts.length === 0) {
		return {
			role: message.role === "assistant" ? "model" : "user",
			parts: [{ text: " " }], // Use a space as minimal valid content
		}
	}

	return {
		role: message.role === "assistant" ? "model" : "user",
		parts,
	}
}
