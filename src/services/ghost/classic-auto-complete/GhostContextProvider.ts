import * as vscode from "vscode"
import { ContextRetrievalService } from "../../continuedev/core/autocomplete/context/ContextRetrievalService"
import { VsCodeIde } from "../../continuedev/core/vscode-test-harness/src/VSCodeIde"
import { AutocompleteInput } from "../types"
import { HelperVars } from "../../continuedev/core/autocomplete/util/HelperVars"
import { getAllSnippetsWithoutRace } from "../../continuedev/core/autocomplete/snippets/getAllSnippets"
import { getDefinitionsFromLsp } from "../../continuedev/core/vscode-test-harness/src/autocomplete/lsp"
import { DEFAULT_AUTOCOMPLETE_OPTS } from "../../continuedev/core/util/parameters"
import { getSnippets } from "../../continuedev/core/autocomplete/templating/filtering"
import { formatSnippets } from "../../continuedev/core/autocomplete/templating/formatting"
import { GhostModel } from "../GhostModel"

export class GhostContextProvider {
	private contextService: ContextRetrievalService
	private ide: VsCodeIde
	private model: GhostModel

	constructor(context: vscode.ExtensionContext, model: GhostModel) {
		this.ide = new VsCodeIde(context)
		this.contextService = new ContextRetrievalService(this.ide)
		this.model = model
	}

	/**
	 * Get the IDE instance for use by tracking services
	 */
	public getIde(): VsCodeIde {
		return this.ide
	}

	/**
	 * Get context snippets for the current autocomplete request
	 * Returns comment-based formatted context that can be added to prompts
	 */
	async getFormattedContext(autocompleteInput: AutocompleteInput, filepath: string): Promise<string> {
		// Convert filepath to URI if it's not already one
		const filepathUri = filepath.startsWith("file://") ? filepath : vscode.Uri.file(filepath).toString()

		// Initialize import definitions cache
		// this looks like a race, but the contextService only prefetches data here; it's not a mode switch.
		// This odd-looking API seems to be an optimization that's used in continue but not (currently) in our codebase,
		// continue preloads the tree-sitter parse on text editor tab switch to reduce autocomplete latency.
		await this.contextService.initializeForFile(filepathUri)

		// Create helper with URI filepath
		const helperInput = {
			...autocompleteInput,
			filepath: filepathUri,
		}

		const modelName = this.model.getModelName() ?? "codestral"
		const helper = await HelperVars.create(helperInput as any, DEFAULT_AUTOCOMPLETE_OPTS, modelName, this.ide)

		const snippetPayload = await getAllSnippetsWithoutRace({
			helper,
			ide: this.ide,
			getDefinitionsFromLsp,
			contextRetrievalService: this.contextService,
		})

		const filteredSnippets = getSnippets(helper, snippetPayload)

		// Convert all snippet filepaths to URIs
		const snippetsWithUris = filteredSnippets.map((snippet: any) => ({
			...snippet,
			filepath: snippet.filepath?.startsWith("file://")
				? snippet.filepath
				: vscode.Uri.file(snippet.filepath).toString(),
		}))

		const workspaceDirs = await this.ide.getWorkspaceDirs()
		const formattedContext = formatSnippets(helper, snippetsWithUris, workspaceDirs)

		console.log("[GhostContextProvider] - formattedContext:", formattedContext)

		return formattedContext
	}
}
