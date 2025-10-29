import type OpenAI from "openai"

export const apply_diff_single_file = {
	type: "function",
	function: {
		name: "apply_diff",
		description: `Apply precise, targeted modifications to an existing file using search/replace blocks. This tool performs "find and replace" operations - the SEARCH block locates content, and the REPLACE block defines what to put in its place.

CRITICAL RULES:
1. SEARCH block MUST contain at least one line that exactly matches existing file content (including whitespace/indentation). This serves as the "anchor point".
2. SEARCH block CANNOT be empty - even for insertions, you need an anchor line.
3. For insertions: REPLACE = SEARCH content + new content (before or after the anchor).
4. Use 'read_file' first if unsure of exact content.

USE CASES:
- Replace: SEARCH for old content, REPLACE with new content
- Insert after: SEARCH for anchor line, REPLACE with anchor + new lines
- Insert before: SEARCH for anchor line, REPLACE with new lines + anchor
- Delete: SEARCH for content to remove, REPLACE with empty or surrounding content`,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to modify, relative to the current workspace directory.",
				},
				diff: {
					type: "string",
					description: `One or more search/replace blocks. Format:
<<<<<<< SEARCH
 :start_line:[line_number]
 -------
 [exact content to find - must match file exactly]
 =======
 [new content to replace with]
 >>>>>>> REPLACE

EXAMPLES:

Example 1 - Replace text:
Original file:
  Line 1
  Line 2
  Line 3
Operation:
<<<<<<< SEARCH
 :start_line:2
 -------
 Line 2
 =======
 New Line 2
 >>>>>>> REPLACE

Example 2 - Insert AFTER a line:
Original file:
  Line 1
  Line 2
  Line 3
Operation (insert after Line 2):
<<<<<<< SEARCH
 :start_line:2
 -------
 Line 2
 =======
 Line 2
 Inserted line after Line 2
 >>>>>>> REPLACE

Example 3 - Insert BEFORE a line:
Original file:
  Line 1
  Line 2
  Line 3
Operation (insert before Line 2):
<<<<<<< SEARCH
 :start_line:2
 -------
 Line 2
 =======
 Inserted line before Line 2
 Line 2
 >>>>>>> REPLACE

Example 4 - Multiple changes:
<<<<<<< SEARCH
 :start_line:5
 -------
 old code line 5
 =======
 new code line 5
 >>>>>>> REPLACE
<<<<<<< SEARCH
 :start_line:10
 -------
 old code line 10
 =======
 new code line 10
 >>>>>>> REPLACE`,
				},
			},
			required: ["path", "diff"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

//@ts-ignore Preparing for when we enable multi-file diffs
export const apply_diff_multi_file = {
	type: "function",
	function: {
		name: "apply_diff",
		description: `Apply precise, targeted modifications to multiple files in a single operation. This tool performs "find and replace" operations - SEARCH block locates content, REPLACE block defines what to put in its place.

CRITICAL RULES:
1. SEARCH block MUST contain at least one line that exactly matches existing file content (including whitespace/indentation). This serves as the "anchor point".
2. SEARCH block CANNOT be empty - even for insertions, you need an anchor line.
3. For insertions: REPLACE = SEARCH content + new content (before or after the anchor).
4. Use 'read_file' first to confirm file content.
5. For modifications involving multiple lines or complex logic, consider breaking 'apply_diff' into smaller, independent 'diff' operations.
6. Carefully verify the 'start_line' parameter to ensure it matches the actual starting line number of the 'SEARCH' block in the file.
7. If 'apply_diff' fails, immediately 'read_file' the target file again, analyze the error message, and reconstruct the 'diff' based on the latest file content.

USE CASES:
- Replace: SEARCH for old content, REPLACE with new content
- Insert after: SEARCH for anchor line, REPLACE with anchor + new lines
- Insert before: SEARCH for anchor line, REPLACE with new lines + anchor
- Delete: SEARCH for content to remove, REPLACE with empty or surrounding content

COMPLETE EXAMPLE:
{
  "files": [
    {
      "path": "src/utils.ts",
      "diffs": [
        {
          "content": "<<<<<<< SEARCH\nexport function oldFunc() {\n  return 'old'\n}\n=======\nexport function newFunc() {\n  return 'new'\n}\n>>>>>>> REPLACE",
          "start_line": 10
        },
        {
          "content": "<<<<<<< SEARCH\nimport { helper } from './helper'\n=======\nimport { helper } from './helper'\nimport { newHelper } from './newHelper'\n>>>>>>> REPLACE",
          "start_line": 1
        }
      ]
    },
    {
      "path": "src/config.ts",
      "diffs": [
        {
          "content": "<<<<<<< SEARCH\nconst DEBUG = false\n=======\nconst DEBUG = true\n>>>>>>> REPLACE",
          "start_line": 5
        }
      ]
    }
  ]
}`,
		parameters: {
			type: "object",
			properties: {
				files: {
					type: "array",
					description: "A list of file modification operations to perform.",
					items: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description:
									"The path of the file to modify, relative to the current workspace directory.",
							},
							diffs: {
								type: "array",
								description:
									"A list of diffs to apply to the file. Each diff is a distinct search/replace operation.",
								items: {
									type: "object",
									properties: {
										content: {
											type: "string",
											description: `REQUIRED: A complete SEARCH/REPLACE block. This is NOT just the content to insert - it MUST include the full block structure with SEARCH and REPLACE sections.

MANDATORY FORMAT:
<<<<<<< SEARCH
[exact content to find - must match file exactly]
=======
[new content to replace with]
>>>>>>> REPLACE

WARNING: Do NOT use this format:
{
  "content": "new content",
  "start_line": 95
}

CORRECT FORMAT:
{
  "content": "<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE",
  "start_line": 95
}

EXAMPLES:

Replace:
<<<<<<< SEARCH
old line
=======
new line
>>>>>>> REPLACE

Insert after anchor:
<<<<<<< SEARCH
anchor line
=======
anchor line
new line inserted after
>>>>>>> REPLACE

Insert before anchor:
<<<<<<< SEARCH
anchor line
=======
new line inserted before
anchor line
>>>>>>> REPLACE`,
										},
										start_line: {
											type: "integer",
											description:
												"OPTIONAL: The approximate line number where the SEARCH block begins. This is a hint for faster matching, NOT a replacement for the SEARCH block. The SEARCH block content is what actually locates the change.",
										},
									},
									required: ["content", "start_line"],
								},
							},
						},
						required: ["path", "diffs"],
					},
				},
			},
			required: ["files"],
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
