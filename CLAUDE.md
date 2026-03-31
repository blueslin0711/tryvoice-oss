# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

TryVoice 是一个语音运行时，为 AI 代理提供语音接口——支持唤醒词激活、按键说话（PTT）、实时流式传输，在浏览器中运行。

## 常用命令

### 后端 (Python FastAPI)

```bash
# 启动开发服务器
source .venv/bin/activate
python -m backend.cli          # 或直接运行 tryvoice

# Lint 和格式检查
ruff check apps/host-runtime/
ruff format --check apps/host-runtime/

# 运行测试
pytest
```

### 前端 (TypeScript/Vite)

```bash
cd apps/client-web/frontend

# 开发模式
npm run dev

# 类型检查
npx tsc --noEmit

# 构建
npm run build

# 运行测试
npm run test          # vitest run
```

### 开发环境启停

前后端联合开发推荐使用启停脚本：

```bash
bash scripts/dev.sh start    # 启动前后端开发环境
bash scripts/dev.sh stop     # 停止前后端
bash scripts/dev.sh status   # 查看运行状态
bash scripts/dev.sh restart  # 重启前后端
bash scripts/dev.sh logs     # 查看日志
```

启动后：
- **前端**: https://localhost:5173 (Vite dev server，带热更新)
- **后端**: http://localhost:7860 (FastAPI)
- 前端 Vite 代理自动将 API 请求转发到后端

### 一键设置

```bash
bash scripts/setup.sh            # 宯整设置（venv + backend + frontend）
bash scripts/setup.sh --skip-frontend  # 仅后端
```

## 架构

```
apps/
├── host-runtime/backend/    # Python FastAPI 后端
│   ├── adapter/             # Adapter 实现 (claude_code, openclaw)
│   ├── adapter_sdk/         # Adapter SDK 定义 (contract.py 是核心协议)
│   ├── ws/                  # WebSocket 处理器 (handler.py 是主要入口)
│   ├── routes/              # HTTP API 路由
│   ├── session/             # 会话管理和 Turn 执行器
│   └── voice/               # STT/TTS 相关
│
└── client-web/frontend/src/ # TypeScript 前端
    ├── network/             # WebSocket 客户端和消息分发
    ├── state/               # 状态管理 (bot-turn-state, mic-state)
    ├── ui/                  # UI 组件
    ├── audio/               # 音频播放和 STT
    └── wakeword/            # 唤醒词检测
```

**通信协议**: Browser ↔ Backend 通过 WebSocket (`/ws`)，消息类型见 `backend/protocol/constants.py`

## 关键协议

### Adapter SDK (`backend/adapter_sdk/contract.py`)

添加新的 AI 代理适配器需实现 `AgentAdapter` Protocol：
- `stream_user_turn()` — 流式返回 AI 响应，yield `AdapterEvent`
- `report_capabilities()` — 返回 `AdapterCapabilities` 声明功能支持
- `fetch_history()`, `cancel()`, `switch_slot()` 等可选方法

### WebSocket 消息 (`backend/ws/handler.py`)

消息处理入口，处理客户端发来的各种消息类型（如 `user_turn`, `cancel`, `switch_slot`）。

## 代码风格

- **Python**: ruff (line-length 120, target py39)
- **TypeScript**: ESLint + strict mode
- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`)

## 环境配置

关键环境变量见 `.env.example`：
- `TRYVOICE_ACTIVE_ADAPTER` — 适配器类型 (`echo`, `openai-compat`, `anthropic`, `openclaw`)
- `GROQ_API_KEY` — 云端 STT（可选）
- `EDGE_TTS_VOICE` — TTS 语音设置
- `PORT` — 服务器端口（默认 7860）

## 前端关键模块

- `src/network/ws-client.ts` — WebSocket 连接管理
- `src/network/ws-dispatcher.ts` — 消息分发到各模块
- `src/state/bot-turn-state.ts` — Bot 轮次状态跟踪
- `src/main.ts` — 主入口，组装所有模块

## 自定义唤醒词训练

项目使用 openWakeWord (OWW) 框架进行唤醒词检测，支持自定义中文唤醒词。

### 训练流程

```bash
# 1. 生成样本 (使用 scripts/generate_samples.py)
python scripts/generate_samples.py --keyword "你的唤醒词" --output-dir training_samples/你的唤醒词

# 2. 在 Docker 中训练 (确保 ONNX 格式正确)
docker build -f Dockerfile.train -t tryvoice-train .
docker run --rm -v $(pwd):/app tryvoice-train \
  --samples training_samples/你的唤醒词/positive \
  --keyword "你的唤醒词" \
  --negative-samples training_samples/negative \
  --steps 20000

# 3. 模型输出到 apps/host-runtime/backend/wakeword/oww/你的唤醒词.onnx
```

### 关键技术点

- **音频格式**: 16kHz, 16bit, mono PCM WAV
- **ONNX 要求**: IR=7, opset=13, 输入形状 (batch, 16, 96)
- **负向样本**: 使用真实语音而非随机噪声，推荐用其他中文短语
- **样本数量**: 正向 50+，负向 100+ 效果较好

### 已训练唤醒词

- `大橘大橘` — 示例唤醒词
- `大橘子` — 示例唤醒词

配置使用在 `shared_settings.json` 的 `wwMapping` 字段。