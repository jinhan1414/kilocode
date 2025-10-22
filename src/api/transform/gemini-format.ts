import { Anthropic } from "@anthropic-ai/sdk"
import { Content, Part } from "@google/genai"

export function convertAnthropicContentToGemini(content: string | Anthropic.ContentBlockParam[]): Part[] {
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

				// Get tool name from the saved tool_name field
				const toolName = (block as any).tool_name || block.tool_use_id

				if (typeof block.content === "string") {
					return {
						functionResponse: {
							id: block.tool_use_id,
							name: toolName,
							response: { output: block.content },
						},
					}
				}

				if (!Array.isArray(block.content)) {
					return []
				}

				const textParts: string[] = []
				const imageParts: Part[] = []

				for (const item of block.content) {
					if (item.type === "text") {
						textParts.push(item.text)
					} else if (item.type === "image" && item.source.type === "base64") {
						const { data, media_type } = item.source
						imageParts.push({ inlineData: { data, mimeType: media_type } })
					}
				}

				// Create content text with a note about images if present
				const contentText =
					textParts.join("\n\n") + (imageParts.length > 0 ? "\n\n(See next part for image)" : "")

				// Return function response followed by any images
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

export function convertAnthropicMessageToGemini(message: Anthropic.Messages.MessageParam): Content {
	return {
		role: message.role === "assistant" ? "model" : "user",
		parts: convertAnthropicContentToGemini(message.content),
	}
}
