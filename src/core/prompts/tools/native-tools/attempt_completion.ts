import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "attempt_completion",
		description: `MANDATORY: You MUST call this tool when the task is complete to present your final result to the user.

WHEN TO USE:
- After all required tool operations have been executed successfully
- When you have received confirmation that previous tool uses succeeded
- When the user's request has been fully addressed
- When you have completed all modifications, creations, or analyses requested

WHEN NOT TO USE:
- While waiting for tool execution results from the user
- If any previous tool use failed or returned an error
- If you haven't received user confirmation of success for previous operations

WORKFLOW:
1. Execute necessary tools (read_file, apply_diff, write_file, etc.)
2. Wait for user confirmation that tools succeeded
3. Once confirmed successful, IMMEDIATELY call attempt_completion
4. Provide a clear summary of what was accomplished

IMPORTANT: Failure to call this tool after successful task completion will leave the user waiting indefinitely. Always use this tool to formally complete the task and present your results.

WARNING: Do NOT use this tool if previous operations failed or are still pending - this could cause code corruption.`,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				result: {
					type: "string",
					description: `A clear, concise summary of what was accomplished. Include:
- What changes were made (files modified, created, or deleted)
- Key outcomes or results
- Any important notes or next steps

Example: "Successfully implemented the login feature by creating auth.ts with JWT authentication and updating the main app.ts to use the new auth middleware. The feature is ready for testing."

Keep it professional and informative, but concise.`,
				},
			},
			required: ["result"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
