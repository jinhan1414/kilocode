# 代码库索引项目级配置 - 最小化方案

## 核心目标

**只让 `codebaseIndexEnabled` 变成项目级配置，其他配置保持全局不变，改动最小。**

## 最小化实现（仅3处改动）

### 改动1: ContextProxy - 简化方法签名

**文件**: `src/core/config/ContextProxy.ts`

```typescript
// 修改前（需要传context参数）
async updateWorkspaceState(context: vscode.ExtensionContext, key: string, value: any) {
    await context.workspaceState.update(key, value)
}

async getWorkspaceState(context: vscode.ExtensionContext, key: string) {
    return await context.workspaceState.get(key)
}

// 修改后（使用内部context）
async updateWorkspaceState(key: string, value: any) {
    await this.originalContext.workspaceState.update(key, value)
}

async getWorkspaceState(key: string) {
    return await this.originalContext.workspaceState.get(key)
}
```

### 改动2: CodeIndexConfigManager - 从workspaceState读取enabled

**文件**: `src/services/code-index/config-manager.ts`

在 `loadConfiguration()` 方法中，**只添加3行代码**：

```typescript
public async loadConfiguration(): Promise<{...}> {
    // 【新增】读取项目级的enabled状态
    const workspaceEnabled = await this.contextProxy.getWorkspaceState("codebaseIndexEnabled")

    // 现有代码...
    const previousConfigSnapshot: PreviousConfigSnapshot = {...}
    await this.contextProxy.refreshSecrets()
    this._loadAndSetConfiguration()

    // 【新增】覆盖enabled值（如果workspace中没有值，默认false）
    if (workspaceEnabled !== undefined) {
        this.codebaseIndexEnabled = workspaceEnabled
    } else {
        this.codebaseIndexEnabled = false
    }

    const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)
    return {...}
}
```

**注意**: 不修改 `_loadAndSetConfiguration()`，保持它从globalState读取enabled（作为后备）。

### 改动3: webviewMessageHandler - 保存到workspaceState

**文件**: `src/core/webview/webviewMessageHandler.ts`

在 `saveCodeIndexSettingsAtomic` case中，**只添加5行代码**：

```typescript
case "saveCodeIndexSettingsAtomic": {
    if (!message.codeIndexSettings) {
        break
    }

    const settings = message.codeIndexSettings

    try {
        // 【新增】如果包含enabled，保存到workspaceState
        if (settings.codebaseIndexEnabled !== undefined) {
            await provider.contextProxy.updateWorkspaceState(
                "codebaseIndexEnabled",
                settings.codebaseIndexEnabled
            )
        }

        // 现有代码：保存到globalState（包含enabled作为后备）
        const globalStateConfig = {
            ...currentConfig,
            codebaseIndexEnabled: settings.codebaseIndexEnabled,
            // ... 其他配置
        }
        await updateGlobalState("codebaseIndexConfig", globalStateConfig)

        // 现有代码：保存secrets...
        // 现有代码：发送响应...
    } catch (error) {
        // 错误处理
    }
    break
}
```

## 工作原理

1. **读取优先级**: workspaceState > globalState > 默认值(false)
2. **保存策略**: 同时保存到workspaceState和globalState（globalState作为后备）
3. **向后兼容**: 如果workspaceState中没有值，仍然从globalState读取

## 为什么这是最小化方案

1. **不修改数据结构** - globalState中仍然保存enabled（向后兼容）
2. **不修改UI** - UI不需要知道配置级别的区别
3. **不修改其他配置逻辑** - 只影响enabled字段
4. **只添加代码** - 几乎不删除现有代码
5. **渐进式迁移** - 旧项目仍然可以从globalState读取

## 测试场景

### 场景1: 新项目

- workspaceState: 无值
- 结果: enabled = false（默认关闭）

### 场景2: 旧项目（升级前）

- globalState: enabled = true
- workspaceState: 无值
- 结果: enabled = false（新行为：项目默认关闭）

### 场景3: 用户在项目中启用

- 保存到: workspaceState + globalState
- 结果: enabled = true（项目级）

### 场景4: 切换项目

- 项目A: workspaceState = true
- 项目B: workspaceState = false
- 结果: 每个项目独立配置

## 可选改进（不影响功能）

如果想让UI显示这是项目级设置，可以在checkbox旁边加个tooltip：

```tsx
<StandardTooltip content="此设置针对当前项目">
	<span className="codicon codicon-info" />
</StandardTooltip>
```

但这不是必需的，功能已经完整。
