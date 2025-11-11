import { describe, it, expect, beforeEach, vi } from "vitest"
import { GhostContextProvider } from "../GhostContextProvider"
import { AutocompleteInput } from "../../types"
import { AutocompleteSnippetType } from "../../../continuedev/core/autocomplete/snippets/types"
import { GhostModel } from "../../GhostModel"
import * as vscode from "vscode"
import crypto from "crypto"

vi.mock("vscode", () => ({
	Uri: {
		parse: (uriString: string) => ({
			toString: () => uriString,
			fsPath: uriString.replace("file://", ""),
		}),
		file: (path: string) => ({
			toString: () => `file://${path}`,
			fsPath: path,
		}),
	},
	workspace: {
		textDocuments: [],
		workspaceFolders: [],
	},
	window: {
		activeTextEditor: null,
	},
}))

vi.mock("../../../continuedev/core/autocomplete/context/ContextRetrievalService", () => ({
	ContextRetrievalService: vi.fn().mockImplementation(() => ({
		initializeForFile: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("../../../continuedev/core/vscode-test-harness/src/VSCodeIde", () => ({
	VsCodeIde: vi.fn().mockImplementation(() => ({
		getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
	})),
}))

vi.mock("../../../continuedev/core/autocomplete/util/HelperVars", () => ({
	HelperVars: {
		create: vi.fn().mockResolvedValue({
			filepath: "file:///test.ts",
			lang: { name: "typescript", singleLineComment: "//" },
		}),
	},
}))

vi.mock("../../../continuedev/core/autocomplete/snippets/getAllSnippets", () => ({
	getAllSnippetsWithoutRace: vi.fn().mockResolvedValue({
		recentlyOpenedFileSnippets: [],
		importDefinitionSnippets: [],
		rootPathSnippets: [],
		recentlyEditedRangeSnippets: [],
		recentlyVisitedRangesSnippets: [],
		diffSnippets: [],
		clipboardSnippets: [],
		ideSnippets: [],
		staticSnippet: [],
	}),
}))

vi.mock("../../../continuedev/core/autocomplete/templating/filtering", () => ({
	getSnippets: vi
		.fn()
		.mockImplementation((_helper, payload) => [
			...payload.recentlyOpenedFileSnippets,
			...payload.importDefinitionSnippets,
		]),
}))

vi.mock("../../../continuedev/core/autocomplete/templating/formatting", () => ({
	formatSnippets: vi.fn().mockImplementation((helper, snippets) => {
		if (snippets.length === 0) return ""
		const comment = helper.lang.singleLineComment
		return snippets.map((s: any) => `${comment} Path: ${s.filepath}\n${s.content}`).join("\n")
	}),
}))

function createAutocompleteInput(filepath: string = "/test.ts"): AutocompleteInput {
	return {
		isUntitledFile: false,
		completionId: crypto.randomUUID(),
		filepath,
		pos: { line: 0, character: 0 },
		recentlyVisitedRanges: [],
		recentlyEditedRanges: [],
	}
}

describe("GhostContextProvider", () => {
	let contextProvider: GhostContextProvider
	let mockContext: vscode.ExtensionContext
	let mockModel: GhostModel

	beforeEach(() => {
		vi.clearAllMocks()
		mockContext = {
			subscriptions: [],
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
			},
		} as any

		mockModel = {
			getModelName: vi.fn().mockReturnValue("codestral"),
		} as any

		contextProvider = new GhostContextProvider(mockContext, mockModel)
	})

	describe("getFormattedContext", () => {
		it("should return empty string when no snippets available", async () => {
			const input = createAutocompleteInput("/test.ts")
			const formatted = await contextProvider.getFormattedContext(input, "/test.ts")

			expect(formatted).toBe("")
		})

		it("should return formatted context when snippets are available", async () => {
			const { getAllSnippetsWithoutRace } = await import(
				"../../../continuedev/core/autocomplete/snippets/getAllSnippets"
			)

			;(getAllSnippetsWithoutRace as any).mockResolvedValueOnce({
				recentlyOpenedFileSnippets: [
					{
						filepath: "/recent.ts",
						content: "const recent = 1;",
						type: AutocompleteSnippetType.Code,
					},
				],
				importDefinitionSnippets: [],
				rootPathSnippets: [],
				recentlyEditedRangeSnippets: [],
				recentlyVisitedRangesSnippets: [],
				diffSnippets: [],
				clipboardSnippets: [],
				ideSnippets: [],
				staticSnippet: [],
			})

			const input = createAutocompleteInput("/test.ts")
			const formatted = await contextProvider.getFormattedContext(input, "/test.ts")

			const expected = "// Path: file:///recent.ts\nconst recent = 1;"
			expect(formatted).toBe(expected)
		})

		it("should format multiple snippets correctly", async () => {
			const { getAllSnippetsWithoutRace } = await import(
				"../../../continuedev/core/autocomplete/snippets/getAllSnippets"
			)

			;(getAllSnippetsWithoutRace as any).mockResolvedValueOnce({
				recentlyOpenedFileSnippets: [
					{
						filepath: "/file1.ts",
						content: "const first = 1;",
						type: AutocompleteSnippetType.Code,
					},
				],
				importDefinitionSnippets: [
					{
						filepath: "/file2.ts",
						content: "const second = 2;",
						type: AutocompleteSnippetType.Code,
					},
				],
				rootPathSnippets: [],
				recentlyEditedRangeSnippets: [],
				recentlyVisitedRangesSnippets: [],
				diffSnippets: [],
				clipboardSnippets: [],
				ideSnippets: [],
				staticSnippet: [],
			})

			const input = createAutocompleteInput("/test.ts")
			const formatted = await contextProvider.getFormattedContext(input, "/test.ts")

			const expected = "// Path: file:///file1.ts\nconst first = 1;\n// Path: file:///file2.ts\nconst second = 2;"
			expect(formatted).toBe(expected)
		})

		it("should propagate errors from getAllSnippetsWithoutRace", async () => {
			const { getAllSnippetsWithoutRace } = await import(
				"../../../continuedev/core/autocomplete/snippets/getAllSnippets"
			)

			;(getAllSnippetsWithoutRace as any).mockRejectedValueOnce(new Error("Test error"))

			const input = createAutocompleteInput("/test.ts")

			await expect(contextProvider.getFormattedContext(input, "/test.ts")).rejects.toThrow("Test error")
		})
	})
})
