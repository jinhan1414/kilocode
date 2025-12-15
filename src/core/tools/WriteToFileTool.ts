import path from "path"
import fs from "fs/promises"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath, createDirectoriesForFile } from "../../utils/fs"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { getReadablePath } from "../../utils/path"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { everyLineHasLineNumbers, stripLineNumbers } from "../../integrations/misc/extract-text"
import { Task } from "../task/Task"

type WriteToFileParams = { path: string; content: string }

export class WriteToFileTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const

	parseLegacy(params: Partial<Record<string, string>>): WriteToFileParams {
		return {
			path: params.path ?? "",
			content: params.content ?? "",
		}
	}

	private preprocessContent(task: Task, content: string): string {
		let processed = content
		const fenceMatch = processed.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/)
		if (fenceMatch) processed = fenceMatch[1]
		const modelId = task.api?.getModel?.().id ?? ""
		if (!modelId.toLowerCase().startsWith("claude")) {
			processed = unescapeHtmlEntities(processed)
		}
		if (everyLineHasLineNumbers(processed)) {
			processed = stripLineNumbers(processed)
		}
		return processed
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const legacy = this.parseLegacy(block.params as any)
		const filePath = legacy.path
		const content = legacy.content
		if (!filePath || content === undefined) return

		if (!task.diffViewProvider?.editType) {
			const absolutePath = path.resolve(task.cwd, filePath)
			const exists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = exists ? "modify" : "create"
			if (!exists) await createDirectoriesForFile(absolutePath)
		} else if (task.diffViewProvider.editType === "create") {
			const absolutePath = path.resolve(task.cwd, filePath)
			await createDirectoriesForFile(absolutePath)
		}

		await task.diffViewProvider?.open(filePath)
		const processed = this.preprocessContent(task, content)
		await task.diffViewProvider?.update(processed, false)
		await task.ask?.("tool", processed, true).catch(() => {})
	}

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult, toolProtocol } = callbacks
		const filePath = params.path
		let content = params.content

		if (!filePath) {
			task.consecutiveMistakeCount++
			task.recordToolError?.("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))
			return
		}
		if (content === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError?.("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			return
		}

		try {
			const absolutePath = path.resolve(task.cwd, filePath)

			if (task.rooIgnoreController && !task.rooIgnoreController.validateAccess(filePath)) {
				task.consecutiveMistakeCount++
				task.recordToolError?.("write_to_file")
				pushToolResult(formatResponse.rooIgnoreError(getReadablePath(task.cwd, filePath)))
				return
			}

			if (!task.diffViewProvider?.editType) {
				const exists = await fileExistsAtPath(absolutePath)
				task.diffViewProvider.editType = exists ? "modify" : "create"
				if (!exists) await createDirectoriesForFile(absolutePath)
			} else if (task.diffViewProvider.editType === "create") {
				await createDirectoriesForFile(absolutePath)
			}

			isPathOutsideWorkspace(absolutePath)

			if (task.diffViewProvider.editType === "create") {
				try {
					await fs.access(absolutePath)
				} catch {
					await createDirectoriesForFile(absolutePath)
					await fs.writeFile(absolutePath, "", "utf8")
				}
			}

			await task.diffViewProvider?.open(filePath)
			content = this.preprocessContent(task, content)
			await task.diffViewProvider?.update(content, true)

			const approved = await askApproval("tool")
			if (!approved) {
				await task.diffViewProvider?.revertChanges()
				return
			}

			const saveResult = await task.diffViewProvider?.saveChanges()
			const isNewFile = task.diffViewProvider?.editType === "create"
			await task.fileContextTracker?.trackFileContext(filePath, "roo_edited")
			task.didEditFile = true

			if (task.diffViewProvider?.pushToolWriteResult) {
				const msg = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, isNewFile)
				pushToolResult(saveResult?.newProblemsMessage ? `${msg}${saveResult.newProblemsMessage}` : msg)
			} else {
				pushToolResult(formatResponse.toolResult("write_to_file completed"))
			}
		} catch (error) {
			await handleError("writing file", error as Error)
			await task.diffViewProvider?.reset()
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
