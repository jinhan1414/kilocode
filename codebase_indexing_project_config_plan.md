# 整改方案：代码库索引按项目配置（最终实施版）

**目标**：实现一个混合配置系统，其中代码库索引的开启状态是项目级的，其他配置项保持全局级别。

**核心思路**：

1.  **混合配置系统**：`codebaseIndexEnabled` 使用项目级配置（`workspaceState`），其他 `codebaseIndex...` 配置项使用全局配置（`globalState`）。
2.  **默认关闭**：对于一个全新的项目（或从未配置过的项目），代码库索引功能 (`codebaseIndexEnabled`) 默认为 `false`。
3.  **分层配置**：在加载配置时，`codebaseIndexEnabled` 优先从项目配置读取，其他配置项从全局配置读取。
4.  **独立控制**：每个项目可以独立控制是否启用代码库索引，但索引的具体配置（如索引范围、排除规则等）保持全局统一。

---

## 待解决的关键问题及实施策略

### 1. 混合配置加载逻辑

- **问题**: 需要实现混合配置加载，`codebaseIndexEnabled` 从项目配置读取，其他配置项从全局配置读取。
- **策略**: 在 `CodeIndexConfigManager` 中，配置加载逻辑如下：
    1.  `codebaseIndexEnabled` 的优先级：
        - `projectConfig.codebaseIndexEnabled` (如果存在)
        - `false` (默认值)
    2.  其他 `codebaseIndex...` 配置项：
        - `globalConfig.otherSettings` (如果存在)
        - 各配置项的默认值

### 2. 分离保存逻辑

- **问题**: 需要将 `codebaseIndexEnabled` 保存到项目配置，其他配置项保存到全局配置。
- **策略**: 修改 `webviewMessageHandler.ts` 中的 `saveCodeIndexSettingsAtomic` 方法：
    1.  如果包含 `codebaseIndexEnabled`，将其保存到 `workspaceState`
    2.  其他配置项保存到 `globalState`
    3.  确保两个保存操作原子性

---

## 详细实施步骤

1.  **修改 `CodeIndexConfigManager`**

    - **文件**: `src/services/code-index/config-manager.ts`
    - **操作**:
        - 在 `_loadAndSetConfiguration` 方法中，修改配置加载逻辑。
        - 首先，从 `globalState` 读取全局配置（除 `codebaseIndexEnabled` 之外的所有 `codebaseIndex...` 项）。
        - 然后，从 `workspaceState` 读取项目级的 `codebaseIndexEnabled` 配置。
        - 如果 `workspaceState` 中不存在 `codebaseIndexEnabled`，则将其默认值设置为 `false`。
        - 将 `this.codebaseIndexEnabled` 的值更新为从项目配置中读取或默认的 `false`。

2.  **修改 `webviewMessageHandler`**

    - **文件**: `src/core/webview/webviewMessageHandler.ts`
    - **操作**:
        - 在 `saveCodeIndexSettingsAtomic` 方法中，分离保存逻辑。
        - 当 `settings` 对象中包含 `codebaseIndexEnabled` 键时，使用 `contextProxy.updateWorkspaceState` 将其值单独保存到项目配置中。
        - 从 `settings` 对象中移除 `codebaseIndexEnabled`，然后将剩余的全局配置项保存到 `globalState` 中。

3.  **修改 `webview-ui` (UI)**
    - **文件**: `webview-ui/src/components/chat/CodeIndexPopover.tsx`
    - **操作**:
        - 在 "启用代码库索引" 复选框旁边添加一个 tooltip 或说明性文本。
        - 文案内容为：“此设置为当前项目启用代码库索引。其他索引相关配置为全局设置。”
        - 确保当用户保存设置时，`codebaseIndexEnabled` 和其他设置被正确发送到后端。
