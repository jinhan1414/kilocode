# Ask Followup Question Tool Restore

## Summary

- Restored `src/core/tools/AskFollowupQuestionTool.ts` to match `upstream/main`.
- Ensures follow-up answers are written to `user_feedback` and returned as `<answer>...</answer>` tool results.
- Prevents the "tool did not return anything" state that dropped user input after follow-up prompts.

## Test Notes

- Command attempted: `cd src; pnpm test core/tools/__tests__/askFollowupQuestionTool.spec.ts`
- Result: build failed in `webview-ui` due to `RouterModels` missing `openai` field in `getModelsByProvider` tests.
