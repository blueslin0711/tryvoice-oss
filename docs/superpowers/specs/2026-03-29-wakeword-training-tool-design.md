# 唤醒词训练工具页设计文档

日期: 2026-03-29
状态: 待实现

## 背景

TryVoice 项目需要为用户提供一个唤醒词训练工具页，允许用户：
- 创建新的唤醒词模型
- 对现有唤醒词进行个性化微调
- 在线验证模型效果
- 安装或导出训练结果

现有代码已具备部分功能：
- `personalization-wizard.ts`：浏览器端个性化微调（仅支持录制 5 个样本微调现有模型）
- `personalization-trainer.ts`：TensorFlow.js 微调训练
- `scripts/generate_samples.py`：edge-tts 样本生成
- `scripts/train_wakeword_v3.py`：Python PyTorch 完整训练

## 设计决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 功能范围 | 新建 + 微调结合 | 用户可创建新唤醒词，也可个性化现有模型 |
| 样本来源 | 麦克风为主 + TTS 补充 | 真人样本质量更好，TTS 补充数量不足 |
| 训练位置 | 混合模式 | 新建用后端（能力完整），微调用浏览器端（复用现有） |
| 验证方式 | 实时测试 + 批量回测 | 两种场景各有用途 |
| 导出安装 | 一键安装 + 可选下载 | 便捷为主，下载作备份 |
| UI 方案 | 独立工具页 | 流程清晰，复用现有组件，避免 wizard 膨胀 |

## 整体架构

### 页面流程

```
[1. 输入唤醒词] → [2. 样本采集] → [3. 模型训练] → [4. 在线验证] → [5. 安装/导出]
```

### 阶段详情

**阶段 1：输入唤醒词**
- 文本输入框，用户输入唤醒词（如「小助手」）
- 规范提示：建议 2-4 个字，避免常见词
- 前端校验输入有效性

**阶段 2：样本采集**
- 麦克风录制区：
  - 目标样本数量（默认 20 个）
  - 录音按钮 + 波形可视化
  - 每条录音显示时长、质量评分，可删除重录
- TTS 补充区：
  - 显示当前录制数 vs 目标数
  - 不足时提供「用 TTS 补充」按钮
  - 可选 TTS 语音类型

**阶段 3：模型训练**
- 新建唤醒词：后端 PyTorch 训练，轮询进度
- 个性化微调：浏览器端 TensorFlow.js 训练
- 显示进度条、当前阶段、预计时间

**阶段 4：在线验证**
- 实时测试：麦克风实时检测，显示触发状态
- 批量回测：用已录制样本验证，显示成功率

**阶段 5：安装/导出**
- 一键安装：热加载到当前实例
- 下载模型：`.onnx` + `.onnx.data` + `.json`

## 前端设计

### 文件结构

新增文件位于 `apps/client-web/frontend/src/wakeword/`：

| 文件 | 职责 |
|------|------|
| `training-tool.ts` | 主控制器，管理阶段切换和状态 |
| `training-tool-ui.ts` | 各阶段 UI 渲染函数 |
| `sample-collector.ts` | 样本采集逻辑（录音 + TTS 补充） |
| `model-validator.ts` | 在线验证逻辑（实时测试 + 批量回测） |

### 状态结构

```typescript
interface TrainingToolState {
  // 阶段控制
  stage: 'keyword' | 'samples' | 'training' | 'validation' | 'install';

  // 阶段 1
  keyword: string;
  keywordValid: boolean;

  // 阶段 2
  micSamples: AudioSample[];
  ttsSamples: AudioSample[];
  targetSampleCount: number;
  recordingInProgress: boolean;

  // 阶段 3
  trainingMode: 'new' | 'finetune';
  trainingProgress: TrainingProgress;

  // 阶段 4
  validationResults: ValidationResult[];

  // 阶段 5
  modelFile: string;
  modelData: ArrayBuffer;
}

interface AudioSample {
  id: string;
  source: 'mic' | 'tts';
  audioData: Float32Array;
  duration: number;
  rms: number;
  valid: boolean;
}

interface TrainingProgress {
  step: number;
  totalSteps: number;
  loss: number;
  accuracy: number;
  phase: 'preparing' | 'training' | 'exporting';
}

interface ValidationResult {
  sampleId: string;
  detected: boolean;         // 是否触发唤醒词
  confidence: number;        // 置信度 (0-1)
  latencyMs: number;         // 检测延迟 (毫秒)
}
```

### 复用现有代码

| 组件 | 复用来源 | 复用内容 |
|------|----------|----------|
| 录音 UI + 波形动画 | `personalization-wizard.ts` | `startRecordingAudio`, `startWaveformAnimation` |
| 样本质量校验 | `personalization-wizard.ts` | 时长、RMS 检查逻辑 |
| 微调训练 | `personalization-trainer.ts` | `trainKeyword`, `loadNegativeFeatures` |
| 热加载模型 | `wakeword-manager.ts` | `owwHotSwapKeywordWeights` |
| 特征提取 | `personalization-features.ts` | `extractBatchFeatures` |

## 后端设计

### API 端点

新增 `apps/host-runtime/backend/routes/wakeword_training.py`：

| 端点 | 用途 |
|------|------|
| `POST /wakeword/train/samples` | 上传麦克风录制样本 |
| `POST /wakeword/train/tts-generate` | 生成 TTS 补充样本 |
| `POST /wakeword/train/start` | 启动训练任务 |
| `GET /wakeword/train/status/{taskId}` | 查询训练进度 |
| `GET /wakeword/train/result/{taskId}` | 获取训练结果 |
| `DELETE /wakeword/train/{taskId}` | 取消训练任务，清理临时资源 |
| `POST /wakeword/train/install` | 安装模型到项目 |

### 后端模块结构

新增文件：

| 文件 | 职责 |
|------|------|
| `routes/wakeword_training.py` | 训练 API 路由 |
| `voice/training_service.py` | 训练任务管理器 |
| `voice/tts_generator.py` | edge-tts 调用封装 |
| `wakeword/temp/` | 训练临时存储目录 |

### 负向样本处理

训练唤醒词模型需要负向样本（不包含唤醒词的语音）。处理方案：

| 来源 | 说明 |
|------|------|
| **项目内置负向样本库** | 复用 `scripts/generate_samples.py` 中预定义的中文短语，项目自带约 20 个负向短语 |
| **其他唤醒词样本** | 使用项目中其他已训练唤醒词的正向样本作为负向样本（如用户训练「小助手」时，「大橘大橘」的样本可作为负向） |
| **动态 TTS 生成** | 当负向样本不足时，后端调用 edge-tts 生成额外的中文短语样本 |

后端训练服务自动处理负向样本组合，无需用户手动提供。默认负向样本数量与正向样本数量相等。

### API 详情

**POST /wakeword/train/samples**

请求：
```
FormData {
  keyword: string;
  samples: Blob[];
  sampleType: 'mic' | 'tts';
}
```

响应：
```json
{
  "success": true,
  "sampleCount": 15,
  "sessionId": "train_abc123"
}
```

**POST /wakeword/train/tts-generate**

请求：
```json
{
  "keyword": "小助手",
  "count": 5,
  "voice": "zh-CN-XiaoxiaoNeural"
}
```

响应：
```json
{
  "success": true,
  "generatedCount": 5,
  "sessionId": "train_abc123"
}
```

**POST /wakeword/train/start**

请求：
```json
{
  "keyword": "小助手",
  "sessionId": "train_abc123",
  "steps": 20000
}
```

响应：
```json
{
  "success": true,
  "taskId": "task_xyz789"
}
```

**说明**：`sessionId` 用于关联上传的样本，`taskId` 用于追踪训练进度。前端应保存 `taskId` 以便轮询状态，用户刷新页面后可通过 `localStorage` 中保存的 `taskId` 恢复状态。

**GET /wakeword/train/status/{taskId}**

响应：
```json
{
  "status": "running",
  "progress": {
    "step": 8000,
    "totalSteps": 20000,
    "loss": 0.0234,
    "accuracy": 0.92
  },
  "modelReady": false
}
```

**GET /wakeword/train/result/{taskId}**

响应：
```json
{
  "success": true,
  "keyword": "小助手",
  "modelUrl": "/wakeword/temp/小助手.onnx",
  "dataUrl": "/wakeword/temp/小助手.onnx.data",
  "metaUrl": "/wakeword/temp/小助手.json"
}
```

**POST /wakeword/train/install**

请求：
```json
{
  "keyword": "小助手",
  "taskId": "task_xyz789"
}
```

响应：
```json
{
  "success": true,
  "installedPath": "apps/host-runtime/backend/wakeword/oww/小助手.onnx"
}
```

**DELETE /wakeword/train/{taskId}**

用途：取消正在运行的训练任务，清理临时存储资源。

响应：
```json
{
  "success": true,
  "message": "Training cancelled and resources cleaned up"
}
```

### 训练模式选择规则

训练模式 (`new` vs `finetune`) 由前端根据唤醒词是否已存在自动判断：

| 条件 | 训练模式 |
|------|----------|
| 唤醒词不存在于项目中 | `new` — 后端 PyTorch 全量训练 |
| 唤醒词已存在于项目中 | `finetune` — 浏览器端 TensorFlow.js 微调 |

前端在阶段 1 输入唤醒词后，调用 `GET /config` 检查 `wwMapping` 中是否已有该唤醒词，自动设置 `trainingMode`。用户无需手动选择。

## 数据流

```
前端                                    后端
 │                                        │
 ├─ [阶段1] 输入唤醒词                     │
 │                                        │
 ├─ [阶段2] 样本采集                       │
 │    ├─ 麦克风录制                        │
 │    │    └─ POST /samples ─────────────→│ 存储样本
 │    │                                    │
 │    ├─ TTS 补充                          │
 │    │    └─ POST /tts-generate ────────→│ edge-tts 生成
 │    │                                    │
 ├─ [阶段3] 训练                           │
 │    ├─ 新建模式                          │
 │    │    ├─ POST /start ───────────────→│ 启动 PyTorch 训练
 │    │    ├─ GET /status (轮询) ─────────→│ 返回进度
 │    │    └─ GET /result ───────────────→│ 返回模型
 │    │                                    │
 │    ├─ 微调模式                          │
 │    │    └─ 浏览器端 TensorFlow.js       │
 │    │                                    │
 ├─ [阶段4] 验证                           │
 │    ├─ 实时测试 (加载模型检测)           │
 │    ├─ 批量回测                          │
 │    │                                    │
 ├─ [阶段5] 安装/导出                      │
 │    ├─ POST /install ──────────────────→│ 移动到正式目录
 │    ├─ 下载模型文件                      │
 │                                        │
```

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 唤醒词不规范 | 前端校验，显示错误，阻止继续 |
| 麦克风权限拒绝 | 显示引导，提供「仅用 TTS」选项 |
| 样本质量不合格 | 标记 invalid，提示重录 |
| TTS 生成失败 | 显示提示，可继续录制补充 |
| 后端训练失败 | 显示详情，提供重试或返回 |
| 训练超时 (>10分钟) | 显示提示，后台继续，可选等待或放弃 |
| 模型安装失败 | 提供下载选项 |
| 验证成功率过低 (<80%) | 提示效果不佳，建议补充样本重训 |

### 辅助功能

- **阶段回退**：每阶段提供「返回上一步」按钮
- **进度保存**：样本数据保存 localStorage，可恢复
- **训练取消**：提供取消按钮，清理临时资源

## 测试策略

### 前端测试

| 测试内容 | 测试方法 |
|----------|----------|
| 录音质量校验 | 单元测试：过短、过静、正常样本 |
| TTS 补充触发 | 单元测试：样本不足时提示 |
| 阶段切换 | 集成测试：状态正确传递 |
| 进度恢复 | 单元测试：localStorage 保存/恢复 |

### 后端测试

| 测试内容 | 测试方法 |
|----------|----------|
| 样本上传存储 | 单元测试：正确保存临时目录 |
| TTS 生成 | 单元测试：edge-tts 调用、音频格式 |
| 训练任务生命周期 | 单元测试：创建、运行、完成、清理 |
| 并发训练 | 单元测试：多任务不冲突 |
| API 端点 | 集成测试：请求响应格式 |

### 端到端测试

| 测试内容 | 测试方法 |
|----------|----------|
| 完整流程 | E2E：输入唤醒词到安装完成 |
| 验证统计准确性 | E2E：成功率统计正确 |
| 热加载生效 | E2E：安装后模型立即可用 |

## 实现顺序建议

1. **后端 API + 训练服务**：搭建基础设施
2. **前端阶段 1-2**：唤醒词输入 + 样本采集
3. **前端阶段 3**：训练流程（新建 + 微调）
4. **前端阶段 4-5**：验证 + 安装导出
5. **测试覆盖**：单元测试 + E2E 测试
6. **错误处理完善**：各场景错误处理