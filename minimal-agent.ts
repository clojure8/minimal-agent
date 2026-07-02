import { readFileSync, readdirSync, statSync } from "node:fs";

// 配置LLM的调用（全部从环境变量读取，由 .env 文件提供）
const BASE_URL = process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const MODEL = process.env.MODEL;

if (!BASE_URL || !API_KEY || !MODEL) {
  const missing = [
    ["BASE_URL", BASE_URL],
    ["API_KEY", API_KEY],
    ["MODEL", MODEL],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .join(", ");
  throw new Error(
    `缺少环境变量: ${missing}。请复制 .env.example 为 .env 并填入真实值，或在运行时设置环境变量。`,
  );
}

// 消息类型定义
type Msg = {
  role: string;
  content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
};

// 工具类型定义
type Tool = {
  name: string;
  desc: string;
  params: object;
  run: (args: any) => string;
};

// ── 会话级鉴权状态：authenticate 成功后置位，受保护的工具据此放行 ──────────
const authState = { authenticated: false, username: "" };

// ── 定义工具 ──────────────────────────────────────
const tools: Tool[] = [
  {
    name: "list_files",
    desc: "列出目录里的所有文件",
    params: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: ({ path }) =>
      readdirSync(path)
        .map((f) => {
          const s = statSync(`${path}/${f}`);
          return `${s.isDirectory() ? "d" : "-"} ${f}`;
        })
        .join("\n"),
  },
  {
    name: "read_file",
    desc: "读取文件里的具体内容",
    params: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: ({ path }) => readFileSync(path, "utf-8").slice(0, 4000),
  },
  {
    name: "authenticate",
    desc: "鉴权工具：校验 JWT 令牌并返回鉴权结果（fake，仅演示，恒定验证成功）",
    params: {
      type: "object",
      properties: {
        token: { type: "string", description: "JWT 令牌" },
      },
      required: ["token"],
    },
    run: ({ token }) => {
      // fake：不做真实签名校验，尝试解析 payload 中的 sub 作为用户名
      let username = "unknown";
      try {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf-8"),
        );
        username = payload.sub ?? payload.username ?? username;
      } catch {
        // 解析失败也照常返回成功（fake）
      }
      // 置位鉴权状态，供受保护的工具校验
      authState.authenticated = true;
      authState.username = username;
      return JSON.stringify({
        valid: true,
        username,
        message: "JWT 验证成功（fake）",
      });
    },
  },
  {
    name: "get_user_info",
    desc: "查询用户信息的服务接口（fake，仅演示）",
    params: {
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    },
    run: ({ username }) => {
      // 受保护接口：必须先通过 authenticate 鉴权
      if (!authState.authenticated) {
        return JSON.stringify({
          error: "未鉴权：请先调用 authenticate 工具校验 JWT 后再查询用户信息",
        });
      }
      return JSON.stringify({
        username,
        role: "admin",
        email: `${username}@example.com`,
        permissions: ["read", "write", "delete"],
      });
    },
  },
];

// ──  调用大模型 ───────────────────────────────────────

async function callLLM(messages: Msg[]) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.desc, parameters: t.params },
      })),
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  return ((await res.json()) as any).choices[0].message;
}

// ── 共享上下文：整个 Agent 生命周期内复用，跨多轮对话保留记忆 ────────────
// messages 即是 Agent 上下文，也是消息队列；只初始化一次 system prompt。
const messages: Msg[] = [
  {
    role: "system",
    content:
      "You are a helpful assistant. Use tools when needed. " +
      "调用 get_user_info 之前，必须先调用 authenticate 完成鉴权；若未鉴权，请先向用户索取 JWT 并鉴权。",
  },
];

// ── Agent loop: while + tool dispatch + context array ─────────────
async function agent(prompt: string) {
  // 把本轮用户输入追加到共享上下文，而不是新建数组
  messages.push({ role: "user", content: prompt });

  while (true) {
    const reply = await callLLM(messages);
    messages.push(reply);

    if (!reply.tool_calls?.length) return reply.content as string;

    for (const call of reply.tool_calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      const args = JSON.parse(call.function.arguments);
      let result: string;
      try {
        result = tool ? tool.run(args) : `Unknown tool: ${call.function.name}`;
      } catch (e: any) {
        result = `Error: ${e.message}`;
      }
      console.log(
        `  [${call.function.name}](${JSON.stringify(args)}) → ${result.slice(0, 80)}…`,
      );
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }
}

// ── 命令行交互UI ──────────────────────────────────────────────────────────
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

console.log("极简 Agent (输入 exit 退出)\n");

(async () => {
  while (true) {
    const prompt = await ask("> ");
    if (!prompt || prompt === "exit") break;
    try {
      const answer = await agent(prompt);
      console.log(`\n${answer}\n`);
    } catch (e: any) {
      console.error(`Error: ${e.message}\n`);
    }
  }
  rl.close();
})();
