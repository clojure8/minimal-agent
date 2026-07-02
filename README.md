# 极简 Agent（minimal-agent）

一个用单文件 `src/agent.ts`（约 160 行）实现的最小化 LLM Agent，演示了「工具调用循环（tool-use loop）」这一 Agent 的核心机制：模型自主决定何时调用工具，拿到结果后继续思考，直到给出最终回答。

支持任意 **OpenAI 兼容** 的 `/chat/completions` 接口（DeepSeek、OpenAI、Moonshot、通义千问、本地 Ollama 等）。

## 功能

- 多轮对话：`messages` 数组在整个进程生命周期内复用，跨轮保留记忆
- 内置工具：
  - `list_files` — 列出目录下的文件
  - `read_file` — 读取文件内容（截断到 4000 字符）
  - `authenticate` — 鉴权工具（fake）：校验 JWT，恒定验证成功
  - `get_user_info` — 查询用户信息（fake）：返回 admin，**调用前必须先鉴权**

## 环境要求

- Node.js >= 18（推荐 18/20/22，本项目已在 v22 验证）
- 一个 OpenAI 兼容接口的 API Key

## 1. 安装依赖

```bash
npm install
```

## 2. 配置

配置全部通过环境变量提供，程序启动时从 `.env` 读取。复制示例文件并填入真实值：

```bash
cp .env.example .env
```

编辑 `.env`，三个变量都必填，缺任意一个都会在启动时报错退出：

```ini
# LLM 接口基地址（不含 /chat/completions）
BASE_URL=https://api.deepseek.com
# 你的 API Key
API_KEY=sk-xxxxxxxxxxxxxxxx
# 模型名
MODEL=deepseek-chat
```

说明：
- `BASE_URL` 只写到根路径，程序会自动拼接 `/chat/completions`。
- `.env` 已被 `.gitignore` 忽略，不会误提交密钥。
- 也可以不写 `.env`，改为在运行时用环境变量注入，例如：
  ```bash
  BASE_URL=https://api.deepseek.com API_KEY=sk-xxx MODEL=deepseek-chat npm start
  ```

### 常见接口配置参考

| 提供方 | BASE_URL | MODEL 示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5` |

## 3. 运行

```bash
npm start
```

启动后进入命令行交互，看到 `>` 提示符即可输入。输入 `exit` 或空行退出：

```
极简 Agent (输入 exit 退出)

> 列出当前目录的文件
  [list_files]({"path":"."}) → - src/agent.ts...

当前目录下有 ...

> 用这个 JWT 登录并查询我的用户信息：eyJhbGciOi...
  [authenticate]({"token":"eyJ..."}) → {"valid":true,...
  [get_user_info]({"username":"alice"}) → {"username":"alice","role":"admin",...

你的角色是 admin ...
```

### 其他脚本

```bash
npm run dev        # 监听文件变化自动重启（tsx watch）
npm run typecheck  # 只做类型检查，不产出文件
npm run build      # 用 tsc 编译
```

## 鉴权约束说明

`get_user_info` 是受保护接口：内部会检查会话级鉴权状态，未先调用 `authenticate` 时会直接返回错误提示，模型据此会先索取 JWT 完成鉴权，再查询用户信息。一次鉴权后在当前进程内持续有效。

## 常见问题

- **启动报「缺少环境变量」**：说明 `.env` 没建好或某个变量为空，对照上文补齐 `BASE_URL` / `API_KEY` / `MODEL`。
- **`LLM error 401`**：API Key 无效或额度用尽。
- **`LLM error 404`**：多半是 `BASE_URL` 拼错（比如多写/少写了 `/v1`）或 `MODEL` 名不对。
