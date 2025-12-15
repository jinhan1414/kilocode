import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"

type AskFollowupParams = {
	question: string
	follow_up: Array<{ text: string; mode?: string }>
}

function parseSuggestions(followUpXml: string): Array<{ answer: string; mode?: string }> {
	const results: Array<{ answer: string; mode?: string }> = []
	const regex = /<suggest(?:\s+mode="([^"]+)")?>([\s\S]*?)<\/suggest>/g
	let match: RegExpExecArray | null
	while ((match = regex.exec(followUpXml)) !== null) {
		const mode = match[1] || undefined
		const answer = match[2].trim()
		if (answer) results.push(mode ? { answer, mode } : { answer })
	}
	return results
}

export class AskFollowupQuestionTool extends BaseTool<"ask_followup_question"> {
	readonly name = "ask_followup_question" as const

	parseLegacy(params: Partial<Record<string, string>>): AskFollowupParams {
		const followUp = params.follow_up ?? ""
		const suggestions = followUp ? parseSuggestions(followUp) : []
		return {
			question: params.question ?? "",
			follow_up: suggestions.map((s) => ({ text: s.answer, mode: s.mode })),
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_followup_question">): Promise<void> {
		const params = this.parseLegacy(block.params as any)
		const question = params.question || (block.nativeArgs as any)?.question
		if (!question) return

		try {
			await task.ask?.("followup", question, true)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// Task.ask() intentionally throws "Current ask promise was ignored" for partial asks.
			// Partial followup rendering is best-effort and should never surface as an error.
			if (message.includes("Current ask promise was ignored")) {
				return
			}
			if (message.includes("aborted")) {
				return
			}
			console.warn(`[AskFollowupQuestionTool] Failed to render partial followup question: ${message}`)
		}
	}

	async execute(params: AskFollowupParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, toolProtocol } = callbacks
		const question = params.question
		const suggest = params.follow_up.map((s) => ({ answer: s.text, mode: s.mode ?? undefined }))
		await task.ask?.("followup", JSON.stringify({ question, suggest }), false)
		pushToolResult("")
	}
}

export const askFollowupQuestionTool = new AskFollowupQuestionTool()
