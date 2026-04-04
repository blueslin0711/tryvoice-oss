# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

TryVoice 是一个语音交互运行时，为 AI 代理（如 Claude Code、OpenClaw）提供语音接口。支持唤醒词激活、按键说话、实时流式响应，运行在浏览器中。

## 语言偏好

用户偏好中文友好的对话和文档交流。请使用中文进行沟通。

## 常用开发命令

### 环境设置

```bash
# 一键设置（创建虚拟环境、安装依赖、构建前端）
bash scripts/setup.sh

# 仅设置后端（无需 Node.js）
bash scripts/setup.sh --skip-frontend

# 激活虚拟环境
source .venv/bin/activate
```

### 启动服务

```bash
# 启动服务器并打开浏览器
tryvoice

# 仅启动服务器（不打开浏览器）
tryvoice --no-browser

# 指定端口和主机
tryvoice --host 0.0.0.0 --port 7860

# CLI 设置向导
tryvoice --setup
```

### 前端开发

```bash
cd apps/client-web/frontend

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 运行前端测试
npm run test

# ESLint 检查
npm run lint

# TypeScript 类型检查（构建时自动运行）
tsc
```

### Python 后端开发

```bash
# 安装开发依赖
pip install -e ".[dev]"

# 运行 ruff lint 检查
ruff check apps/host-runtime/backend

# 运行 pytest 测试（如果存在）
pytest

# 直接运行模块
python -m backend.cli
```

### Docker

```bash
docker compose up
# 访问 https://localhost:7860
```

## 架构概览

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│  Browser UI  │◄──────────────────►│   TryVoice       │
│  (PWA)       │                    │   Runtime         │
│              │                    │                   │
│  Wake Word   │                    │  ┌────────────┐   │──► Claude Code
│  STT / TTS   │                    │  │  Adapter    │   │──► OpenClaw
│  Audio I/O   │                    │  │  Registry   │   │──► 自定义 adapter
└─────────────┘                    └──┴────────────┴───┘
```

### 核心目录结构

```
apps/
├── host-runtime/backend/    # Python FastAPI 后端
│   ├── adapter/             # Adapter 实现 (Claude Code, OpenClaw)
│   ├── adapter_sdk/         # Adapter SDK 协议定义
│   ├── routes/              # HTTP/WebSocket 路由
│   ├── session/             # 会话状态机 (turn_fsm.py, orchestrator.py)
│   ├── voice/               # STT/TTS 提供者
│   ├── ws/                  # WebSocket 处理器
│   ├── config/              # 配置管理
│   └── mirror/              # Telegram/飞书镜像通道
│
└── client-web/frontend/     # TypeScript 前端 (Vite + PWA)
    └── src/
        ├── audio/           # 音频录制/播放
        ├── wakeword/        # 唤醒词检测 (OpenWakeWord)
        ├── state/           # 前端状态机
        ├── network/         # WebSocket 连接
        ├── ui/              # UI 组件
        └── __tests__/       # Vitest 测试
```

### 关键模块

- **Adapter SDK** (`adapter_sdk/contract.py`): 定义 `AgentAdapter` 协议，所有 AI 代理适配器必须实现此接口
- **会话状态机** (`session/turn_fsm.py`): 管理语音交互的完整生命周期（idle → listening → processing → speaking）
- **WebSocket 处理器** (`ws/handler.py`): 处理前端与后端的双向实时通信
- **前端测试** (`src/__tests__/`): 使用 Vitest，测试命名以 `inv-*`（集成）、`sc-*`（场景）、`pi-*`（产品意图）为前缀

## 构建 Adapter

连接 TryVoice 到任何 AI 代理，需实现 `AgentAdapter` 协议：

```python
from backend.adapter_sdk import AdapterCapabilities, AdapterEvent

class MyAdapter:
    def report_capabilities(self) -> AdapterCapabilities:
        return AdapterCapabilities(supports_stream=True, ...)

    async def stream_user_turn(self, *, bot_id, session_key, text, ...):
        yield AdapterEvent(type="assistant_delta", bot_id=bot_id, text="Hello!")
        yield AdapterEvent(type="assistant_final", bot_id=bot_id)
```

注册 entry point：

```toml
[project.entry-points."tryvoice.adapters"]
my-agent = "my_package.adapter:MyAdapter"
```

## 配置

环境变量见 `.env.example`：

- `TRYVOICE_ACTIVE_ADAPTER`: 活动适配器 (`echo`, `claude-code`, `openclaw`)
- `GROQ_API_KEY`: Groq STT API 密钥
- `EDGE_TTS_VOICE`: Edge TTS 语音设置
- `PORT`: 服务端口（默认 7860）

## 测试指南

前端测试使用 Vitest，位于 `apps/client-web/frontend/src/__tests__/`：

```bash
cd apps/client-web/frontend
npm run test        # 运行所有测试
```

测试命名约定：
- `inv-*`: 集成测试
- `sc-*`: 场景测试
- `pi-*`: 产品意图测试

## 构建与发布

```bash
# 构建前端并复制到后端 static-dist
cd apps/client-web/frontend
npm run build
# setup.sh 会自动复制构建产物

# 构建 Python 包
bash scripts/build-package.sh
```