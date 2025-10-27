# 代码库索引项目级配置 - 修正方案

## 原文档的错误分析

### 错误1: WorkspaceState API 使用错误

**原文档问题**:

```typescript
// 错误的API调用方式
await contextProxy.updateWorkspaceState(key, value)
await contextProxy.getWorkspaceState(key)
```

**实际代码**:

```typescript
// ContextProxy.ts 中的实际实现
async updateWorkspaceState(context: vscode.ExtensionContext, key: string, value: any) {
    await context.workspaceState.update(key, value)
}

async getWorkspaceState(context: vscode.ExtensionContext, key: string) {
    return await context.workspaceState.get(key)
}
```

**问题**: 这些方法需要传入 `context` 参数,但原文档没有考虑到这一点。

### 错误2: 混合配置系统的复杂性

原文档试图实现一个混合系统,其中 `codebaseIndexEnabled` 使用项目级配置,其他配置使用全局配置。这会导致:

1. 配置加载逻辑复杂
2. 保存逻辑需要分离处理
3. UI 需要特殊处理来区分不同配置级别

### 错误3: 没有考虑现有架构

当前代码中:

- `CodeIndexConfigManager` 从 `globalState` 读取所有配置
- `webviewMessageHandler` 的 `saveCodeIndexSettingsAtomic` 保存到 `globalState`
- UI 组件 `CodeIndexPopover` 不区分配置级别

## 最小化实现方案

### 核心思路

**只修改 `codebaseIndexEnabled` 的存储位置,其他配置保持全局级别不变。**

### 实施步骤

#### 1. 修改 `CodeIndexConfigManager` 的配置加载

**文件**: `src/services/code-index/config-manager.ts`

```typescript
private _loadAndSetConfiguration(): void {
    // 加载全局配置(除 enabled 外的所有配置)
    const codebaseIndexConfig = this.contextProxy?.getGlobalState("codebaseIndexConfig") ?? {
        codebaseIndexQdrantUrl: "http://localhost:6333",
        codebaseIndexEmbedderProvider: "openai",
        codebaseIndexEmbedderBaseUrl: "",
        codebaseIndexEmbedderModelId: "",
        codebaseIndexSearchMinScore: undefined,
        codebaseIndexSearchMaxResults: undefined,
    }

    // 从 workspaceState 读取项目级的 enabled 状态
    // 注意: 需要传入 context 参数
    const workspaceEnabled = await this.contextProxy.getWorkspaceState(
        this.contextProxy.rawContext,
        "codebaseIndexEnabled"
    )

    // 如果 workspaceState 中没有值,默认为 false
    this.codebaseIndexEnabled = workspaceEnabled ?? false

    // 其他配置从全局配置加载
    const {
        codebaseIndexQdrantUrl,
        codebaseIndexEmbedderProvider,
        codebaseIndexEmbedderBaseUrl,
        codebaseIndexEmbedderModelId,
        codebaseIndexSearchMinScore,
        codebaseIndexSearchMaxResults,
    } = codebaseIndexConfig

    // ... 其余代码保持不变
}
```

**问题**: `_loadAndSetConfiguration` 是同步方法,但 `getWorkspaceState` 是异步的。

**解决方案**: 需要将 `_loadAndSetConfiguration` 改为异步方法,或者在初始化时单独处理。

#### 2. 修改 `webviewMessageHandler` 的保存逻辑

**文件**: `src/core/webview/webviewMessageHandler.ts`

在 `saveCodeIndexSettingsAtomic` case 中:

```typescript
case "saveCodeIndexSettingsAtomic": {
    if (!message.codeIndexSettings) {
        break
    }

    const settings = message.codeIndexSettings

    try {
        // 分离 enabled 和其他配置
        const { codebaseIndexEnabled, ...globalSettings } = settings

        // 1. 保存 enabled 到 workspaceState
        if (codebaseIndexEnabled !== undefined) {
            await provider.contextProxy.updateWorkspaceState(
                provider.context,
                "codebaseIndexEnabled",
                codebaseIndexEnabled
            )
        }

        // 2. 保存其他配置到 globalState
        const currentConfig = getGlobalState("codebaseIndexConfig") || {}
        const globalStateConfig = {
            ...currentConfig,
            ...globalSettings,
        }
        await updateGlobalState("codebaseIndexConfig", globalStateConfig)

        // 3. 保存 secrets
        if (settings.codeIndexOpenAiKey !== undefined) {
            await provider.contextProxy.storeSecret("codeIndexOpenAiKey", settings.codeIndexOpenAiKey)
        }
        // ... 其他 secrets

        // 发送成功响应
        await provider.postMessageToWebview({
            type: "codeIndexSettingsSaved",
            success: true,
            settings: globalStateConfig,
        })

        // ... 其余代码保持不变
    } catch (error) {
        // 错误处理
    }
    break
}
```

#### 3. UI 修改(可选)

**文件**: `webview-ui/src/components/chat/CodeIndexPopover.tsx`

在 "启用代码库索引" 复选框旁边添加提示:

```tsx
<div className="flex items-center gap-2">
	<VSCodeCheckbox
		checked={currentSettings.codebaseIndexEnabled}
		onChange={(e: any) => updateSetting("codebaseIndexEnabled", e.target.checked)}>
		<span className="font-medium">{t("settings:codeIndex.enableLabel")}</span>
	</VSCodeCheckbox>
	<StandardTooltip content={t("settings:codeIndex.projectLevelSetting")}>
		<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
	</StandardTooltip>
</div>
```

添加翻译键:

```json
{
	"settings": {
		"codeIndex": {
			"projectLevelSetting": "此设置针对当前项目。其他索引配置为全局设置。"
		}
	}
}
```

## 关键问题和解决方案

### 问题1: 异步方法调用

`getWorkspaceState` 和 `updateWorkspaceState` 是异步方法,需要在异步上下文中调用。

**解决方案**:

- 在 `CodeIndexConfigManager.loadConfiguration()` 中处理(已经是异步的)
- 修改 `_loadAndSetConfiguration` 为异步方法,或者将 workspace state 的读取移到外部

### 问题2: Context 参数传递

`workspaceState` 方法需要 `context` 参数。

**解决方案**:

- 在 `CodeIndexConfigManager` 中保存 `context` 引用
- 或者修改 `ContextProxy` 的方法签名,内部使用 `this.originalContext`

### 问题3: 默认值处理

新项目第一次打开时,`workspaceState` 中没有 `codebaseIndexEnabled` 值。

**解决方案**:

- 默认值设为 `false`(原文档正确)
- 在 UI 中明确显示这是项目级设置

## 推荐的最小化实现

### 方案A: 修改 ContextProxy(推荐)

修改 `ContextProxy` 的 `workspaceState` 方法,不需要传入 context:

```typescript
// ContextProxy.ts
async updateWorkspaceState(key: string, value: any) {
    await this.originalContext.workspaceState.update(key, value)
}

async getWorkspaceState(key: string) {
    return await this.originalContext.workspaceState.get(key)
}
```

这样调用时就简单了:

```typescript
const enabled = await this.contextProxy.getWorkspaceState("codebaseIndexEnabled")
await this.contextProxy.updateWorkspaceState("codebaseIndexEnabled", true)
```

### 方案B: 只在必要时读取 WorkspaceState

在 `CodeIndexConfigManager.loadConfiguration()` 中:

```typescript
public async loadConfiguration(): Promise<{...}> {
    // 先读取 workspace state
    const workspaceEnabled = await this.contextProxy.getWorkspaceState(
        this.contextProxy.rawContext,
        "codebaseIndexEnabled"
    )

    // 然后调用同步的 _loadAndSetConfiguration
    this._loadAndSetConfiguration()

    // 覆盖 enabled 值
    this.codebaseIndexEnabled = workspaceEnabled ?? false

    // ... 其余代码
}
```

## 总结

**最小化修改**:

1. 修改 `ContextProxy.ts` 的 `workspaceState` 方法签名(移除 context 参数)
2. 修改 `CodeIndexConfigManager` 的 `loadConfiguration` 方法,从 workspaceState 读取 enabled
3. 修改 `webviewMessageHandler` 的 `saveCodeIndexSettingsAtomic`,分离保存 enabled 到 workspaceState
4. (可选) UI 添加提示说明这是项目级设置

**关键点**:

- 只有 `codebaseIndexEnabled` 是项目级的
- 其他所有配置保持全局级别
- 默认值为 `false`(新项目默认关闭)
- 需要处理异步调用
