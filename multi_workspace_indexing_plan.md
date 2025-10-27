# 多工作区代码索引功能整合计划

## 1. 目标

将代码库索引功能（`codebase_search`）与现有的UI工作区切换功能进行整合。实现当用户在UI中切换工作区时，后端的代码索引目标也随之同步切换，从而支持在多个工作区之间无缝使用代码搜索功能，而无需引入大规模并行索引的复杂性。

## 2. 背景分析

- **`CodeIndexManager` 已支持多实例**: 通过分析 `src/services/code-index/manager.ts`，我们发现 `CodeIndexManager` 内部通过一个静态 `Map` 结构 (`private static instances = new Map<string, CodeIndexManager>()`) 来管理不同工作区路径对应的实例。
- **关键方法 `getInstance`**: `CodeIndexManager.getInstance(context, workspacePath)` 是获取特定工作区索引管理器的核心入口。如果明确传入 `workspacePath`，它就能返回或创建对应的实例。
- **当前调用缺陷**: `src/core/webview/ClineProvider.ts` 中的 `getCurrentWorkspaceCodeIndexManager` 方法在调用 `CodeIndexManager.getInstance` 时未传递工作区路径，导致其始终获取默认工作区的索引管理器。

## 3. 变更方案

利用现有架构，以最小的改动实现目标。核心思路是调整 `ClineProvider` 对 `CodeIndexManager` 的调用方式。

### 步骤 1: 修改 `ClineProvider.ts`

我们将对 `src/core/webview/ClineProvider.ts` 文件进行以下三处修改：

#### 变更 1: 改造 `getCurrentWorkspaceCodeIndexManager` 方法

修改此方法，使其在调用 `CodeIndexManager.getInstance` 时，明确传入当前UI上激活的工作区路径 `this.activeWorkspacePath`。

**文件**: `src/core/webview/ClineProvider.ts`

```typescript
// 变更前
public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
    return CodeIndexManager.getInstance(this.context)
}

// 变更后
public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
    // 如果没有活动工作区路径，则不返回任何管理器
    if (!this.activeWorkspacePath) {
        return undefined
    }
    return CodeIndexManager.getInstance(this.context, this.activeWorkspacePath)
}
```

#### 变更 2: 调整 `setActiveWorkspacePath` 方法

在用户通过UI切换工作区后，除了更新路径状态，还需要立即调用 `updateCodeIndexStatusSubscription()` 来确保索引状态的监听器也同步切换到新的 `CodeIndexManager` 实例上。

**文件**: `src/core/webview/ClineProvider.ts`

```typescript
// 在 setActiveWorkspacePath 方法末尾添加调用

public setActiveWorkspacePath(path: string) {
    this.activeWorkspacePath = path
    this.cwd = path
    setActiveWorkspacePath(this.cwd)
    this.postStateToWebview()

    // 新增调用：确保索引状态订阅切换到新的工作区管理器
    this.updateCodeIndexStatusSubscription()
}
```

#### 变更 3: 调整 `updateWorkspaceState` 方法

当VS Code工作区文件夹列表发生变化时，此方法会被调用。我们需要确保在更新完工作区状态后，也调用 `updateCodeIndexStatusSubscription()` 来刷新索引订阅。

**文件**: `src/core/webview/ClineProvider.ts`

```typescript
// 在 updateWorkspaceState 方法末尾添加调用

private updateWorkspaceState() {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders) {
        this.workspaceFolders = workspaceFolders.map((folder) => ({
            name: folder.name,
            path: folder.uri.fsPath,
        }))
        this.activeWorkspacePath = workspaceFolders[0].uri.fsPath
        this.cwd = this.activeWorkspacePath
        setActiveWorkspacePath(this.cwd)
    } else {
        this.workspaceFolders = []
        this.activeWorkspacePath = ""
        this.cwd = ""
        setActiveWorkspacePath(undefined)
    }

    // 新增调用：确保在工作区文件夹变化时也更新索引订阅
    this.updateCodeIndexStatusSubscription()
}
```

## 4. 预期效果

- 当用户在 Kilo Code 的工作区选择器中切换工作区时，`codebase_search` 的目标范围将自动、即时地切换到新选定的工作区。
- 索引状态（如“正在索引”、“索引完成”等）将准确反映当前选定工作区的状态。
- 无需同时维护多个工作区的索引，避免了额外的性能开销。
- 整体实现风险低，代码改动小，并充分利用了现有架构的优势。
