# Workspace Switch MCP Refresh Fix

## Summary

- Refresh project MCP connections on workspace switch so new workspace configs are loaded.
- Clear stale project MCP servers when the new workspace has no project MCP config.
- Trigger MCP refresh after `switchWorkspace` completes.

## Implementation

- Added `handleWorkspaceSwitch()` to rewatch the project MCP file and refresh project MCP servers.
- Updated `updateProjectMcpServers()` to clean up project MCP connections when no project config exists.
- Called MCP refresh after workspace switching.
- Added unit coverage for workspace switch with no project MCP config.

## Files Changed

- `src/services/mcp/McpHub.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `src/services/mcp/__tests__/McpHub.spec.ts`

## Test Notes

- Command attempted: `cd src; pnpm test services/mcp/__tests__/McpHub.spec.ts`
- Result: build failed in `webview-ui` due to `RouterModels` missing `openai` field in `getModelsByProvider` tests.
