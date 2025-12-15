import { BaseTool, ToolCallbacks } from "./BaseTool"
import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { formatResponse } from "../prompts/responses"

type CodebaseSearchParams = { query: string; path?: string }

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	parseLegacy(params: Partial<Record<string, string>>): CodebaseSearchParams {
		return { query: params.query ?? "", path: params.path }
	}

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const query = params.query
		const directoryPrefix = params.path

		const provider = task.providerRef?.deref()
		const manager = CodeIndexManager.getInstance(provider?.context as any, task.cwd)

		if (!manager || !manager.isFeatureEnabled || !manager.isFeatureConfigured || !manager.isInitialized) {
			pushToolResult(formatResponse.toolError("Semantic code search is not configured or available."))
			await task.say?.(
				"codebase_search_result",
				JSON.stringify({
					tool: "codebaseSearch",
					content: { query, results: [], status: manager?.getCurrentStatus() },
				}),
			)
			return
		}

		const status = manager.getCurrentStatus()
		if (status.systemStatus === "Indexing") {
			const progress =
				status.totalItems && status.processedItems != null
					? ` (Progress: ${status.processedItems}/${status.totalItems} ${status.currentItemUnit}).`
					: "."
			const msg = `${status.message}${progress} Semantic search is unavailable until indexing completes. Please try again later.`
			pushToolResult(formatResponse.toolError(msg))
			await task.say?.(
				"codebase_search_result",
				JSON.stringify({ tool: "codebaseSearch", content: { query, results: [], status } }),
			)
			return
		}

		const results = await manager.searchIndex(query, directoryPrefix)
		pushToolResult("")
		await task.say?.(
			"codebase_search_result",
			JSON.stringify({ tool: "codebaseSearch", content: { query, results, status } }),
		)
	}
}

export const codebaseSearchTool = new CodebaseSearchTool()
