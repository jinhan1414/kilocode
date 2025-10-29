# DiffViewProvider 工作区切换问题修复

## 问题描述

在工作区切换后，`apply_diff` 工具在调用 `cline.diffViewProvider.open(relPath)` 时会报错，因为 `DiffViewProvider` 仍在使用旧的工作目录。

## 根本原因

### 问题链路

1. **DiffViewProvider 构造时固定 cwd**

    ```typescript
    constructor(
        private cwd: string,  // ❌ 在构造时固定，不会更新
        task: Task,
    ) {
        this.taskRef = new WeakRef(task)
    }
    ```

2. **open 方法使用固定的 cwd**

    ```typescript
    async open(relPath: string): Promise<void> {
        const absolutePath = path.resolve(this.cwd, relPath)  // ❌ 使用旧的 cwd
        // ...
    }
    ```

3. **工作区切换后的问题**
    - 用户在前端切换工作区
    - `ClineProvider.cwd` 被更新为新的工作目录
    - `Task.cwd` getter 会返回新的工作目录（从 provider 动态获取）
    - 但 `DiffViewProvider.cwd` 仍然是构造时的旧值
    - 导致 `open()` 方法尝试在旧工作目录中打开文件，文件不存在，报错

### 为什么 Task.cwd 没有问题？

Task 类使用了动态 getter：

```typescript
// Task.ts
public get cwd() {
    const provider = this.providerRef.deref()
    if (provider && provider.cwd) {
        return provider.cwd  // ✅ 动态获取最新的 cwd
    }
    return this.workspacePath  // 回退到创建时的 workspacePath
}
```

## 解决方案

将 `DiffViewProvider.cwd` 从构造时固定的属性改为动态 getter，从 Task 实例获取最新的工作目录。

### 修改内容

**文件**: `src/integrations/editor/DiffViewProvider.ts`

```typescript
// 修改前
constructor(
    private cwd: string,  // ❌ 私有属性，构造时固定
    task: Task,
) {
    this.taskRef = new WeakRef(task)
}

// 修改后
constructor(
    cwd: string,  // ✅ 只是参数，不再存储
    task: Task,
) {
    this.taskRef = new WeakRef(task)
}

/**
 * Get the current working directory dynamically from the task
 * This ensures we always use the latest cwd even after workspace switches
 */
private get cwd(): string {
    const task = this.taskRef.deref()
    return task?.cwd ?? ""  // ✅ 动态获取最新的 cwd
}
```

## 修复效果

### 修复前

1. 用户切换工作区
2. `apply_diff` 工具执行
3. `diffViewProvider.open(relPath)` 使用旧的 cwd
4. ❌ 文件路径错误，报错

### 修复后

1. 用户切换工作区
2. `apply_diff` 工具执行
3. `diffViewProvider.open(relPath)` 通过 getter 获取最新的 cwd
4. ✅ 文件路径正确，成功打开

## 影响范围

`DiffViewProvider` 中所有使用 `this.cwd` 的方法都会受益于这个修复：

- ✅ `open(relPath)` - 打开 diff 编辑器
- ✅ `saveChanges()` - 保存更改
- ✅ `revertChanges()` - 撤销更改
- ✅ `openDiffEditor()` - 打开 diff 编辑器
- ✅ `saveDirectly()` - 直接保存文件

所有这些方法现在都会使用最新的工作目录，确保在工作区切换后正常工作。

## 相关文档

- [工作区切换全链路分析](./workspace-switching-analysis.md) - 工作区切换的完整实现流程
- [Task.ts](../src/core/task/Task.ts) - Task 类的 cwd getter 实现
- [DiffViewProvider.ts](../src/integrations/editor/DiffViewProvider.ts) - DiffViewProvider 实现

## 总结

这个修复通过将 `DiffViewProvider.cwd` 从静态属性改为动态 getter，确保它始终从 Task 实例获取最新的工作目录。这与 Task 类的设计保持一致，并且完全解决了工作区切换后 `apply_diff` 工具报错的问题。

修复的关键点：

1. ✅ 移除构造函数中的 `private` 修饰符
2. ✅ 添加动态 `cwd` getter，从 Task 获取最新值
3. ✅ 保持向后兼容，所有现有代码无需修改
4. ✅ 与 Task 类的设计模式保持一致
