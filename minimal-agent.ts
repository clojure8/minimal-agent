import { readFileSync, readdirSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";

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

async function callLLM(messages: Msg[], useTools = true) {
  const body: any = { model: MODEL, messages };
  // 规划阶段不挂载 tools，避免模型直接调工具而非输出计划
  if (useTools) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.desc, parameters: t.params },
    }));
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
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

// ── Dynamic Workflow 模式：规划(plan)与执行(execute)分离 ──────────────────
// 与上面的 tool-loop 对比：tool-loop 走一步问一次 LLM；workflow 让 LLM 一次性
// 产出整张步骤图，再由纯代码的执行器按依赖拓扑跑（无依赖的步骤并行）。

// 工作流步骤：一步调用一个工具，args 里可用 "${id.field}" 引用前置步骤的输出
type Step = {
  id: string;
  tool: string;
  args: Record<string, any>;
  depends_on: string[];
};

// 让 LLM 把目标编排成一张步骤图（不挂载 tools，要求纯 JSON 输出）
async function planWorkflow(goal: string): Promise<Step[]> {
  const toolList = tools.map((t) => `- ${t.name}: ${t.desc}`).join("\n");
  const reply = await callLLM(
    [
      {
        role: "system",
        content:
          "你是流程规划器。把用户目标编排成一个有向无环的步骤图。\n" +
          "只输出 JSON 数组，不要任何解释、不要 markdown 围栏。\n" +
          '每个步骤形如 {"id":"唯一标识","tool":"工具名","args":{...},"depends_on":["前置步骤id"]}。\n' +
          '若某步参数依赖前置步骤输出，用 "${步骤id.字段}" 引用字段，或 "${步骤id}" 引用整个输出。\n' +
          "可用工具：\n" +
          toolList,
      },
      { role: "user", content: goal },
    ],
    false,
  );
  const text = (reply.content as string).replace(/```json|```/g, "").trim();
  return JSON.parse(text) as Step[];
}

// 把 args 里的 "${id}" / "${id.field}" 占位替换成前置步骤的实际输出
function resolveRefs(args: any, outputs: Record<string, any>): any {
  // 只匹配带引号的整体占位（如 "${auth.username}"），替换后仍是合法 JSON
  const s = JSON.stringify(args).replace(
    /"\$\{(\w+)(?:\.(\w+))?\}"/g,
    (_, id, field) => {
      const out = outputs[id];
      const val = field ? out?.[field] : out;
      return JSON.stringify(val ?? null);
    },
  );
  return JSON.parse(s);
}

// 执行器：按依赖拓扑跑步骤图，无依赖的并行，前置输出自动注入后续步骤
async function runWorkflow(steps: Step[]) {
  const outputs: Record<string, any> = {};
  const done = new Set<string>();
  while (done.size < steps.length) {
    const ready = steps.filter(
      (s) => !done.has(s.id) && s.depends_on.every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      throw new Error("workflow 依赖成环或引用了缺失的步骤");
    }
    // 依赖已就绪的步骤可并行执行
    await Promise.all(
      ready.map(async (s) => {
        const tool = tools.find((t) => t.name === s.tool);
        const args = resolveRefs(s.args, outputs);
        let result: string;
        try {
          result = tool ? tool.run(args) : `Unknown tool: ${s.tool}`;
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }
        console.log(
          `  [${s.id}] ${s.tool}(${JSON.stringify(args)}) → ${result.slice(0, 80)}…`,
        );
        // 尝试解析为对象供后续引用；非 JSON（如 read_file 文本）则存原始字符串
        try {
          outputs[s.id] = JSON.parse(result);
        } catch {
          outputs[s.id] = result;
        }
        done.add(s.id);
      }),
    );
  }
  return outputs;
}

// ── Script 模式：LLM 生成 JS 编排脚本，在 worker 沙箱里执行 ────────────────
// 比 JSON DAG 更强：控制流(for/while/if)由真实 JS 引擎跑，LLM 只在 agent()
// 调用点做决策。脚本运行在独立 worker 线程里，仅能通过注入的原语与外界交互；
// 主线程用超时强制 terminate（能杀死 while(true) 死循环，这是 worker 的关键价值）。

// 子 agent：一次独立的 tool-loop，自带上下文，不污染主会话
async function subAgent(task: string): Promise<string> {
  const local: Msg[] = [
    {
      role: "system",
      content:
        "You are a sub-agent. Use tools to finish the task, then return only the final result.",
    },
    { role: "user", content: task },
  ];
  while (true) {
    const reply = await callLLM(local);
    local.push(reply);
    if (!reply.tool_calls?.length) return (reply.content as string) ?? "";
    for (const call of reply.tool_calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      let result: string;
      try {
        result = tool
          ? tool.run(JSON.parse(call.function.arguments))
          : `Unknown tool: ${call.function.name}`;
      } catch (e: any) {
        result = `Error: ${e.message}`;
      }
      local.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }
}

// 让 LLM 产出一段编排脚本（JS 源码字符串）
async function planScript(goal: string): Promise<string> {
  const toolList = tools.map((t) => `- ${t.name}(args): ${t.desc}`).join("\n");
  const reply = await callLLM(
    [
      {
        role: "system",
        content:
          "你是编排脚本生成器。只输出一段 JavaScript 函数体，不要解释、不要 markdown 围栏。\n" +
          "作用域内已注入以下原语，直接使用：\n" +
          "- await agent(task: string)：派子 agent 完成子任务，返回最终文本\n" +
          "- await parallel([() => ..., ...])：并行执行 thunk，返回结果数组\n" +
          "- await tool(name, args)：直接调用工具，返回字符串\n" +
          "- log(msg)：打印进度\n" +
          "用 return 返回最终结果，可用 if/for/while 等任意控制流。\n" +
          "禁止使用 require/import/process/fs 等，只能通过上述原语与外界交互。\n" +
          "可用工具：\n" +
          toolList,
      },
      { role: "user", content: goal },
    ],
    false,
  );
  return (reply.content as string).replace(/```(?:js|javascript)?|```/g, "").trim();
}

// worker 线程内运行的引导代码（纯 JS 字符串，不经 tsx 转译）。
// 通过 parentPort 与主线程做 RPC：agent/tool 转发到主线程执行，结果回传。
const SANDBOX_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
let seq = 0;
const pending = new Map();
parentPort.on('message', (msg) => {
  if (msg.type === 'rpc-result') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  }
});
const rpc = (method, args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'rpc-call', id, method, args });
});
const agent = (task) => rpc('agent', [task]);
const tool = (name, args) => rpc('tool', [name, args]);
const log = (m) => parentPort.postMessage({ type: 'log', message: String(m) });
const parallel = (thunks) => Promise.all(thunks.map((f) => f()));
(async () => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction('agent', 'parallel', 'tool', 'log', workerData.script);
    const result = await fn(agent, parallel, tool, log);
    parentPort.postMessage({ type: 'done', result });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) });
  }
})();
`;

// 在 worker 沙箱里执行脚本：故障隔离 + 内存上限 + 超时强制终止
function runScriptSandboxed(src: string, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SANDBOX_WORKER_SRC, {
      eval: true,
      workerData: { script: src },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`脚本执行超时（>${timeoutMs}ms），已强制终止`))),
      timeoutMs,
    );
    worker.on("message", async (msg: any) => {
      if (msg.type === "rpc-call") {
        // 主线程执行真正的原语（拥有 fetch/fs 等权限），把结果回传 worker
        try {
          let result: any;
          if (msg.method === "agent") {
            result = await subAgent(msg.args[0]);
          } else if (msg.method === "tool") {
            const t = tools.find((x) => x.name === msg.args[0]);
            result = t ? t.run(msg.args[1]) : `Unknown tool: ${msg.args[0]}`;
          } else {
            throw new Error(`Unknown RPC method: ${msg.method}`);
          }
          worker.postMessage({ type: "rpc-result", id: msg.id, result });
        } catch (e: any) {
          worker.postMessage({
            type: "rpc-result",
            id: msg.id,
            error: String(e?.message ?? e),
          });
        }
      } else if (msg.type === "log") {
        console.log(`  · ${msg.message}`);
      } else if (msg.type === "done") {
        finish(() => resolve(msg.result));
      } else if (msg.type === "error") {
        finish(() => reject(new Error(msg.error)));
      }
    });
    worker.on("error", (e) => finish(() => reject(e)));
  });
}

// script 模式入口：规划脚本 → 展示 → 沙箱执行
async function runScript(goal: string) {
  const src = await planScript(goal);
  console.log(`生成的编排脚本：\n${src}\n`);
  return runScriptSandboxed(src);
}

// ── 命令行交互UI ──────────────────────────────────────────────────────────
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

console.log("极简 Agent (输入 exit 退出)");
console.log("  · 直接输入     → tool-loop 模式（走一步问一次 LLM）");
console.log("  · /plan 目标   → dynamic workflow 模式（LLM 规划 JSON 步骤图，再执行）");
console.log("  · /script 目标 → 脚本模式（LLM 生成 JS 编排脚本，在 worker 沙箱执行）\n");

(async () => {
  while (true) {
    const prompt = await ask("> ");
    if (!prompt || prompt === "exit") break;
    try {
      if (prompt.startsWith("/plan ")) {
        // dynamic workflow：规划 → 展示 → 执行
        const goal = prompt.slice("/plan ".length).trim();
        console.log("规划中…");
        const steps = await planWorkflow(goal);
        console.log(`生成的 workflow：\n${JSON.stringify(steps, null, 2)}\n`);
        const outputs = await runWorkflow(steps);
        console.log(`\n执行完成，各步骤输出：\n${JSON.stringify(outputs, null, 2)}\n`);
      } else if (prompt.startsWith("/script ")) {
        // 脚本模式：LLM 生成编排脚本 → worker 沙箱执行
        const goal = prompt.slice("/script ".length).trim();
        console.log("生成脚本中…");
        const result = await runScript(goal);
        console.log(`\n执行完成，返回结果：\n${JSON.stringify(result, null, 2)}\n`);
      } else {
        const answer = await agent(prompt);
        console.log(`\n${answer}\n`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}\n`);
    }
  }
  rl.close();
})();
