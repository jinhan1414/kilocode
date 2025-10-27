# 代码库索引启用状态修复总结

## 问题

【开启代码库索引】配置存在UI不同步和数据保存混乱问题。

## 根本原因

`codebaseIndexEnabled` 被错误地保存到两个位置：

- ✅ workspaceState（项目级，正确）
- ❌ globalState.codebaseIndexConfig（全局，错误）

## 修复方案

### 数据存储规则

```
项目级配置（workspaceState）:
  - codebaseIndexEnabled ✓

全局配置（globalState.codebaseIndexConfig）:
  - codebaseIndexQdrantUrl
  - codebaseIndexEmbedderProvider
  - codebaseIndexEmbedderBaseUrl
  - codebaseIndexEmbedderModelId
  - codebaseIndexEmbedderModelDimension
  - codebaseIndexOpenAiCompatibleBaseUrl
  - codebaseIndexSearchMaxResults
  - codebaseIndexSearchMinScore

密钥（secrets）:
  - codeIndexOpenAiKey
  - codeIndexQdrantApiKey
  - codebaseIndexOpenAiCompatibleApiKey
  - codebaseIndexGeminiApiKey
  - codebaseIndexMistralApiKey
  - codebaseIndexVercelAiGatewayApiKey
```

### 修改内容

**1. webviewMessageHandler.ts - saveCodeIndexSettingsAtomic**

```typescript
// 修改前：globalStateConfig 包含 codebaseIndexEnabled
const globalStateConfig = {
	...currentConfig,
	codebaseIndexEnabled: settings.codebaseIndexEnabled, // ❌
	// ...
}

// 修改后：globalStateConfig 不包含 codebaseIndexEnabled
const globalStateConfig = {
	codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl, // ✓
	// ... 其他全局配置
	// codebaseIndexEnabled 不在这里
}
```

**2. config-manager.ts - \_loadAndSetConfiguration**

```typescript
// 默认配置不包含 codebaseIndexEnabled
const codebaseIndexConfig = this.contextProxy?.getGlobalState("codebaseIndexConfig") ?? {
	codebaseIndexQdrantUrl: "http://localhost:6333",
	// ... 其他配置
	// 不包含 codebaseIndexEnabled
}
```

**3. CodeIndexPopover.tsx - 前端初始化**

```typescript
// codebaseIndexEnabled 从后端传来的值读取（后端从 workspaceState 读取）
const settings = {
	codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? false,
	// ...
}
```

## 数据流

### 保存流程

```
前端 → saveCodeIndexSettingsAtomic → {
    codebaseIndexEnabled → workspaceState ✓
    其他配置 → globalState.codebaseIndexConfig ✓
    密钥 → secrets ✓
}
```

### 读取流程

```
后端:
  CodeIndexConfigManager.constructor() → workspaceState.get("codebaseIndexEnabled")
  CodeIndexConfigManager._loadAndSetConfiguration() → globalState.get("codebaseIndexConfig")

前端:
  ClineProvider.getStateToPostToWebview() → {
    codebaseIndexEnabled: manager.isFeatureEnabled (from workspaceState)
    其他配置: from globalState.codebaseIndexConfig
  }
```

## 验证测试

- [x] 项目A启用索引，项目B独立状态
- [x] 切换项目后状态正确保持
- [x] 全局配置在所有项目间共享
- [x] 前端UI与后端数据一致

## 影响

- ✅ 最小化修改（仅3处）
- ✅ 向后兼容
- ✅ 解决UI不同步问题
- ✅ 解决数据保存混乱问题
