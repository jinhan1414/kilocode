# Provider 自定义模型 ID 支持

## 背景

之前只有 OpenAI Provider 支持通过设置中的 `openAiModelId` 直接填写任意模型 ID。  
其它 Provider（如 Groq / Gemini 等）虽然暴露了 `apiModelId`，但实现上通常要求该 ID 必须在内部模型表中存在，否则会回退到默认模型，导致用户无法真正使用自定义模型。

本次变更的目标：

- 让尽可能多的 Provider（尤其是 OpenAI 兼容类和 Gemini）都“像 OpenAI 一样”支持任意自定义模型 ID；
- 只通过设置中的文本输入控制实际调用使用的模型，不要求该模型必须出现在 UI 下拉列表或内部模型列表中；
- 在不破坏现有行为的前提下，尽量最小化代码改动范围。

## 影响范围概览

- 抽象层：
    - `src/api/providers/base-openai-compatible-provider.ts`
- 具体 Provider：
    - `src/api/providers/gemini.ts`
- 测试：
    - `src/api/providers/__tests__/base-openai-compatible-provider.spec.ts`
    - `src/api/providers/__tests__/gemini.spec.ts`

## 行为变更详情

### 1. BaseOpenAiCompatibleProvider：放宽 apiModelId 限制

位置：`src/api/providers/base-openai-compatible-provider.ts` 中的 `getModel()` 实现。

变更前：

- 只有当 `options.apiModelId` 在 `providerModels` 的 key 中存在时才会使用该 ID；
- 否则一律回退到 `defaultProviderModelId`，导致“未预置的新模型 ID”无法生效。

变更后：

- 始终优先使用用户配置的 `options.apiModelId` 作为请求模型 ID（即使它不在 `providerModels` 中）；
- `getModel()` 返回：
    - `id`：为字符串形式的 `apiModelId`（若未设置则为 `defaultProviderModelId`）；
    - `info`：
        - 若 `apiModelId` 在 `providerModels` 中：使用对应模型的信息；
        - 否则：回退到默认模型 `defaultProviderModelId` 的 `ModelInfo`。

效果：

- 所有继承 `BaseOpenAiCompatibleProvider` 的 Provider（如 Groq 等）现在都支持在设置中填写任意 `apiModelId`，该值会直接用于请求中的 `model` 字段；
- 即便该 ID 没有预配置元信息，内部仍然会使用默认模型的 `ModelInfo` 做 max tokens、价格等计算，保证兼容性和安全性。

### 2. GeminiHandler：支持任意 apiModelId 并保持动态模型能力

位置：`src/api/providers/gemini.ts` 中的 `getModel()` 实现。

变更前：

- `options.apiModelId` 仅在动态/静态模型表中存在时才会被使用；
- 否则会回退到 `geminiDefaultModelId`，并使用默认 ID 作为返回的模型 ID。

变更后：

- 原始模型 ID 选择：
    - `rawId = options.apiModelId || geminiDefaultModelId`；
- `ModelInfo` 选择顺序：
    - 依次尝试 `this.models[rawId]`、内置 `geminiModels[rawId]`；
    - 若以上均不存在，则回退到默认 ID 对应的动态/静态模型信息；
- 通过 `getModelParams({ format: "gemini", modelId: rawId, ... })` 计算推理/最大输出 token 等；
- 实际 API 调用 ID：
    - 若 `rawId` 以 `:thinking` 结尾，则去掉该后缀作为最终调用 ID，否则直接使用 `rawId`。

效果：

- 设置中填写的任意 `apiModelId`（包括 Vertex 路径或新的 Gemini 模型 ID）都会直接作为请求参数中的模型 ID 使用；
- 如果该 ID 不在当前动态/静态模型列表中，`ModelInfo` 会自动回退到默认模型，以保证 max tokens 与成本估算仍然有合理的默认值。

## 测试与验证

为避免回归，本次变更在原有测试基础上做了补充：

- `src/api/providers/__tests__/base-openai-compatible-provider.spec.ts`
    - 新增用例：验证当设置自定义 `apiModelId = "my-custom-model"` 且该 ID 未预置时：
        - 请求中使用的 `model` 字段为 `"my-custom-model"`；
        - `getModel()` 返回的 `info` 仍然沿用默认模型的 `ModelInfo`（例如 maxTokens / contextWindow）。
- `src/api/providers/__tests__/gemini.spec.ts`
    - 更新原“无效模型”相关用例为：验证当 `apiModelId = "invalid-model"` 时：
        - `getModel().id` 为 `"invalid-model"`；
        - `getModel().info` 来自默认模型，且包含有效的 `maxTokens` 与 `contextWindow`。

在 `src` 目录下使用以下命令运行相关测试：

```bash
cd src && npx vitest run api/providers/__tests__/base-openai-compatible-provider.spec.ts api/providers/__tests__/gemini.spec.ts
```

所有相关用例已经通过。

## 使用说明与兼容性

- OpenAI Provider：
    - 继续沿用原有的 `openAiModelId` 与 `openAiCustomModelInfo` 机制，本次改动未改变其行为。
- 基于 `BaseOpenAiCompatibleProvider` 的 Provider：
    - 建议面向用户的文档描述为：“在设置中填写 `apiModelId` 即可直接指定底层 Provider 使用的模型 ID，若该模型未在内置列表中配置，将复用默认模型的限额与价格作为估值参考。”
- Gemini Provider：
    - 用户可以在设置中填写任意 Gemini / Vertex 模型 ID；若 ID 以 `:thinking` 结尾，将在实际请求时去掉该后缀。

兼容性方面：

- 未设置 `apiModelId` 时，各 Provider 的默认行为与变更前完全一致；
- 自定义模型 ID 仅改变请求所用的模型名称，不会破坏原有 max tokens / 计费等逻辑（因其由默认模型信息兜底），因此对现有使用场景是向后兼容的扩展。
