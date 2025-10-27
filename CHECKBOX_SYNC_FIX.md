# 勾选框不同步问题修复

## 问题

点击保存后，【开启代码库索引】勾选框不同步，需要点两次才能生效。

## 根本原因

保存流程中的状态更新顺序问题：

1. 数据保存到 workspaceState
2. 发送成功消息给前端
3. 更新 webview 状态
4. **ConfigManager 的 enabled 状态未同步** ❌

导致前端收到的状态中 `codebaseIndexEnabled` 仍是旧值。

## 修复方案

### 后端修复 (webviewMessageHandler.ts)

**调整保存流程顺序**：

```typescript
// 修改前
1. 保存到 workspaceState
2. 保存到 globalState
3. 保存 secrets
4. 发送成功消息 ❌ (ConfigManager 状态未更新)
5. 更新 webview 状态 ❌ (状态不同步)
6. 处理验证和初始化

// 修改后
1. 保存到 workspaceState ✓
2. 保存到 globalState ✓
3. 保存 secrets ✓
4. 重新加载 ConfigManager 配置 ✓ (同步 enabled 状态)
5. 更新 webview 状态 ✓ (包含最新状态)
6. 发送成功消息 ✓
7. 处理验证和初始化 ✓
```

**关键代码**：

```typescript
// 6. Handle settings change and sync state
const currentCodeIndexManager = provider.getCurrentWorkspaceCodeIndexManager()
if (currentCodeIndexManager) {
	await currentCodeIndexManager.handleSettingsChange()
}

// 7. Update webview state with fresh data
await provider.postStateToWebview()

// 8. Send success response
await provider.postMessageToWebview({
	type: "codeIndexSettingsSaved",
	success: true,
	settings: globalStateConfig,
})
```

### 前端优化 (CodeIndexPopover.tsx)

**增强状态同步**：

```typescript
// 保存成功后请求最新状态
if (event.data.success) {
	setSaveStatus("saved")
	const savedSettings = { ...currentSettingsRef.current }
	setInitialSettings(savedSettings)
	setCurrentSettings(savedSettings)

	// 请求最新的索引状态和密钥状态
	vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
	vscode.postMessage({ type: "requestIndexingStatus" }) // 新增

	setSaveStatus("idle")
}
```

## 数据流

### 修复后的完整流程

```
用户点击保存
  ↓
前端发送 saveCodeIndexSettingsAtomic
  ↓
后端保存数据:
  1. workspaceState.update("codebaseIndexEnabled", value)
  2. globalState.update("codebaseIndexConfig", {...})
  3. secrets.store(...)
  ↓
后端同步状态:
  4. ConfigManager.loadConfiguration() ← 从 workspaceState 读取最新值
  5. provider.postStateToWebview() ← 包含最新的 enabled 状态
  ↓
后端发送成功消息:
  6. postMessage("codeIndexSettingsSaved")
  ↓
前端更新UI:
  7. 更新本地状态
  8. 请求最新索引状态
  ↓
✅ 勾选框立即同步
```

## 测试验证

- [x] 点击保存后勾选框立即更新
- [x] 不需要点击两次
- [x] 状态在前后端保持一致
- [x] 切换项目后状态正确

## 影响

- ✅ 修复勾选框不同步问题
- ✅ 优化保存流程
- ✅ 增强状态同步可靠性
- ✅ 无副作用
