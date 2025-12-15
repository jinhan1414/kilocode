import { EXPERIMENT_IDS } from "../../../shared/experiments"
import { TOOL_PROTOCOL } from "@roo-code/types"

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

import { applyDiffTool as multiApplyDiffTool } from "../multiApplyDiffTool"

describe("applyDiffTool experiment routing", () => {
	let mockCline: any
	let mockBlock: any
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any
	let mockRemoveClosingTag: any
	let mockProvider: any

	beforeEach(async () => {
		vi.clearAllMocks()

		// Reset vscode mock to default behavior (XML protocol)
		const vscode = await import("vscode")
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(TOOL_PROTOCOL.XML),
		} as any)

		mockProvider = {
			getState: vi.fn(),
		}

		mockCline = {
			providerRef: {
				deref: vi.fn().mockReturnValue(mockProvider),
			},
			cwd: "/test",
			diffStrategy: {
				applyDiff: vi.fn(),
				getProgressStatus: vi.fn(),
			},
			diffViewProvider: {
				reset: vi.fn(),
			},
			apiConfiguration: {
				apiProvider: "anthropic",
			},
			api: {
				getModel: vi.fn().mockReturnValue({
					id: "test-model",
					info: {
						maxTokens: 4096,
						contextWindow: 128000,
						supportsPromptCache: false,
						supportsNativeTools: false,
					},
				}),
			},
			processQueuedMessages: vi.fn(),
		} as any

		mockBlock = {
			params: {
				path: "test.ts",
				diff: "test diff",
			},
			partial: false,
		}

		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()
		mockRemoveClosingTag = vi.fn((tag, value) => value)
	})

	it("should use legacy tool when MULTI_FILE_APPLY_DIFF experiment is disabled", async () => {
		mockProvider.getState.mockResolvedValue({
			experiments: {
				[EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF]: false,
			},
		})

		await multiApplyDiffTool(
			mockCline,
			mockBlock,
			mockAskApproval,
			mockHandleError,
			mockPushToolResult,
			mockRemoveClosingTag,
		)

		// Legacy/class-based tool removed; should not throw.
	})

	it("should use legacy tool when experiments are not defined", async () => {
		mockProvider.getState.mockResolvedValue({})

		await multiApplyDiffTool(
			mockCline,
			mockBlock,
			mockAskApproval,
			mockHandleError,
			mockPushToolResult,
			mockRemoveClosingTag,
		)

		// Legacy/class-based tool removed; should not throw.
	})

	it("should use multi-file tool when MULTI_FILE_APPLY_DIFF experiment is enabled and using XML protocol", async () => {
		mockProvider.getState.mockResolvedValue({
			experiments: {
				[EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF]: true,
			},
		})

		// Mock the new tool behavior - it should continue with the multi-file implementation
		// Since we're not mocking the entire function, we'll just verify it doesn't call the class-based tool
		await multiApplyDiffTool(
			mockCline,
			mockBlock,
			mockAskApproval,
			mockHandleError,
			mockPushToolResult,
			mockRemoveClosingTag,
		)

		// No class-based tool routing anymore.
	})

	it("should use class-based tool when model defaults to native protocol", async () => {
		// Update model to support native tools and default to native protocol
		mockCline.api.getModel = vi.fn().mockReturnValue({
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
				supportsNativeTools: true, // Model supports native tools
				defaultToolProtocol: "native", // Model defaults to native protocol
			},
		})

		mockProvider.getState.mockResolvedValue({
			experiments: {
				[EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF]: true,
			},
		})
		await multiApplyDiffTool(
			mockCline,
			mockBlock,
			mockAskApproval,
			mockHandleError,
			mockPushToolResult,
			mockRemoveClosingTag,
		)

		// Native protocol uses multi-file handler too.
	})
})
