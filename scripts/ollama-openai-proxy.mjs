import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const host = process.env.LLM_PROXY_HOST || "127.0.0.1";
const port = Number(process.env.LLM_PROXY_PORT || 11435);
const openaiBaseUrl = (
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");

const repoRoot = process.cwd();
const apiRoot = join(repoRoot, "apps", "api");
const envFiles = [
  join(repoRoot, ".env"),
  join(repoRoot, ".env.local"),
  join(apiRoot, ".env"),
  join(apiRoot, ".env.local"),
];
const shellEnvKeys = new Set(Object.keys(process.env));
const fileEnvKeys = new Set();

const parseEnvFile = (raw) => {
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
};

for (const envFile of envFiles) {
  if (!existsSync(envFile)) continue;
  const fileEnv = parseEnvFile(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(fileEnv)) {
    if (shellEnvKeys.has(key) && !fileEnvKeys.has(key)) continue;
    process.env[key] = value;
    fileEnvKeys.add(key);
  }
}

const openaiApiKey = process.env.OPENAI_API_KEY;

if (!openaiApiKey) {
  console.error("OPENAI_API_KEY is required to run the OpenAI proxy.");
  process.exit(1);
}

const json = (res, statusCode, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const text = (res, statusCode, body) => {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
};

const isReasoningModel = (model) =>
  /^gpt-5/i.test(model) || /^o[134]/i.test(model);

const toOpenAIMessages = (messages = [], model) => {
  const useDeveloperRole = isReasoningModel(model);

  return messages.map((message) => {
    const role = message?.role ?? "user";
    if (useDeveloperRole && role === "system") {
      return {
        role: "developer",
        content: message?.content ?? "",
      };
    }

    return {
      role,
      content: message?.content ?? "",
    };
  });
};

const mapResponseFormat = (format) => {
  if (!format) return undefined;
  if (format === "json" || format === "json_object") {
    return { type: "json_object" };
  }

  if (typeof format === "object") {
    return {
      type: "json_schema",
      json_schema: {
        name: "ollama_format",
        strict: true,
        schema: format,
      },
    };
  }

  return undefined;
};

const inferResponseFormatFromMessages = (messages = []) => {
  const combined = messages
    .map((message) => `${message?.role ?? ""}: ${message?.content ?? ""}`)
    .join("\n")
    .toLowerCase();

  if (
    /json only/.test(combined) ||
    /output format\s*—\s*json only/.test(combined) ||
    /respond with only valid json/.test(combined) ||
    /\bverdict\b/.test(combined) ||
    /\bcandidates\b/.test(combined) ||
    /\bclarification\b/.test(combined)
  ) {
    return { type: "json_object" };
  }

  return undefined;
};

const inferRequestKindFromMessages = (messages = []) => {
  const combined = messages
    .map((message) => `${message?.role ?? ""}: ${message?.content ?? ""}`)
    .join("\n")
    .toLowerCase();

  if (combined.includes("planner") && combined.includes("verdict")) {
    return "smart-planner";
  }
  if (combined.includes("editor") && combined.includes("summary")) {
    return "dashboard-editor";
  }
  if (combined.includes("clickhouse sql") || combined.includes("write one clickhouse")) {
    return "dynamic-sql";
  }
  if (combined.includes("fixer") || combined.includes("corrected sql")) {
    return "sql-repair";
  }
  if (combined.includes("output format") && combined.includes("json only")) {
    return "vocab-planner";
  }

  return "chat";
};

const responseSchemas = {
  smartPlanner: {
    type: "json_schema",
    json_schema: {
      name: "smart_planner",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          verdict: { type: "string", enum: ["build", "clarify", "no_data"] },
          title: { type: "string" },
          charts: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                sql: { type: "string" },
                xAxisLabel: { type: "string" },
                yAxisLabel: { type: "string" },
              },
              required: ["type", "title", "sql"],
            },
          },
          clarification: {
            type: "object",
            additionalProperties: false,
            properties: {
              question: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["label", "value"],
                },
              },
              reason: { type: "string" },
            },
            required: ["question", "options", "reason"],
          },
          message: { type: "string" },
        },
        required: ["verdict"],
      },
    },
  },
  vocabPlanner: {
    type: "json_schema",
    json_schema: {
      name: "vocab_planner",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidates: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                tools: { type: "array", items: { type: "string" } },
                widgets: {
                  type: "array",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      type: { type: "string" },
                      metric: { type: "string" },
                      grouping: { type: "string" },
                      title: { type: "string" },
                      breakdown: { type: "string" },
                      topN: { type: "number" },
                    },
                    required: ["type", "metric", "grouping", "title"],
                  },
                },
              },
              required: ["title", "widgets"],
            },
          },
        },
        required: ["candidates"],
      },
    },
  },
  editor: {
    type: "json_schema",
    json_schema: {
      name: "dashboard_editor",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          add: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                type: { type: "string" },
                metric: { type: "string" },
                grouping: { type: "string" },
              },
              required: ["title", "description", "type", "metric", "grouping"],
            },
          },
          remove_indices: { type: "array", items: { type: "integer" } },
          modify: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                index: { type: "integer" },
                title: { type: "string" },
                type: { type: "string" },
                description: { type: "string" },
              },
              required: ["index"],
            },
          },
        },
        required: ["summary", "add", "remove_indices", "modify"],
      },
    },
  },
};

const inferResponseSchemaFromMessages = (messages = []) => {
  const combined = messages
    .map((message) => `${message?.role ?? ""}: ${message?.content ?? ""}`)
    .join("\n")
    .toLowerCase();

  if (combined.includes("verdict") && combined.includes("charts")) {
    return responseSchemas.smartPlanner;
  }
  if (combined.includes("candidates") && combined.includes("widgets")) {
    return responseSchemas.vocabPlanner;
  }
  if (combined.includes("summary") && combined.includes("remove_indices")) {
    return responseSchemas.editor;
  }

  return undefined;
};

const previewStructuredResponse = (content) => {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.verdict) {
      const charts = Array.isArray(parsed.charts) ? parsed.charts : [];
      const chartSpecs = charts
        .slice(0, 3)
        .map((chart) => ({
          type: chart?.type,
          metric: chart?.metric,
          grouping: chart?.grouping,
          title: chart?.title,
        }));
      return {
        verdict: parsed.verdict,
        title: parsed.title,
        chartCount: charts.length,
        chartSpecs,
      };
    }
    if (parsed?.summary || parsed?.add || parsed?.modify) {
      return {
        summary: parsed.summary,
        addCount: Array.isArray(parsed.add) ? parsed.add.length : 0,
        modifyCount: Array.isArray(parsed.modify) ? parsed.modify.length : 0,
        removeCount: Array.isArray(parsed.remove_indices)
          ? parsed.remove_indices.length
          : 0,
      };
    }
    return { keys: Object.keys(parsed).slice(0, 8) };
  } catch {
    return { preview: content.slice(0, 200) };
  }
};

const mapOptions = (options = {}) => {
  const mapped = {};
  if (typeof options.temperature === "number")
    mapped.temperature = options.temperature;
  if (typeof options.top_p === "number") mapped.top_p = options.top_p;
  if (typeof options.num_predict === "number" && options.num_predict > 0) {
    mapped.max_completion_tokens = options.num_predict;
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    mapped.stop = options.stop;
  }
  return mapped;
};

const streamOpenAIChatAsOllama = async (body, res) => {
  const model = body.model || process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const stream = body.stream !== false;
  const requestKind = inferRequestKindFromMessages(body.messages);
  const responseFormat =
    mapResponseFormat(body.format) ||
    inferResponseFormatFromMessages(body.messages) ||
    inferResponseSchemaFromMessages(body.messages);
  console.log(
    `[ollama-openai-proxy] chat -> OpenAI model=${model} kind=${requestKind} messages=${messageCount} stream=${stream} format=${responseFormat ? responseFormat.type : "none"}`,
  );
  const response = await fetch(`${openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(body.messages, model),
      stream,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...mapOptions(body.options),
    }),
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => "");
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "OpenAI request failed",
        status: response.status,
        details: errorBody,
      }),
    );
    return;
  }

  if (!stream) {
    const payload = await response.json();
    const assistantContent = payload?.choices?.[0]?.message?.content ?? "";
    const preview = previewStructuredResponse(assistantContent);

    json(res, 200, {
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: assistantContent },
      done: true,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: 0,
      eval_count: assistantContent ? assistantContent.length : 0,
    });
    console.log(
      `[ollama-openai-proxy] chat <- done model=${model} chars=${assistantContent.length} stream=false${preview ? ` preview=${JSON.stringify(preview)}` : ""}`,
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let assistantContent = "";
  let streamFinished = false;

  const flushToken = (content) => {
    if (!content) return;
    assistantContent += content;
    res.write(
      `${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content },
        done: false,
      })}\n`,
    );
  };

  while (!streamFinished) {
    const { value, done } = await reader.read();
    if (done) break;

    carry += decoder.decode(value, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        streamFinished = true;
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const token = parsed?.choices?.[0]?.delta?.content;
      if (token) flushToken(token);
    }
  }

  if (carry.trim()) {
    const trimmed = carry.trim();
    if (trimmed.startsWith("data:")) {
      const data = trimmed.slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          const token = parsed?.choices?.[0]?.delta?.content;
          if (token) flushToken(token);
        } catch {
          // ignore tail parse errors
        }
      }
    }
  }

  res.write(
    `${JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: 0,
      eval_count: assistantContent ? assistantContent.length : 0,
    })}\n`,
  );
  console.log(
    `[ollama-openai-proxy] chat <- done model=${model} chars=${assistantContent.length}`,
  );
  res.end();
};

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      text(res, 400, "Missing request URL.");
      return;
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host || `${host}:${port}`}`,
    );

    if (req.method === "GET" && url.pathname === "/api/tags") {
      console.log("[ollama-openai-proxy] tags request");
      json(res, 200, {
        models: [
          {
            name: process.env.OPENAI_MODEL || "gpt-5.4-mini",
            model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
            modified_at: new Date().toISOString(),
            size: 0,
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      await streamOpenAIChatAsOllama(body, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, provider: "openai-proxy" });
      return;
    }

    text(res, 404, "Not found");
  } catch (error) {
    console.error("[ollama-openai-proxy] request failed:", error);
    if (!res.headersSent) {
      json(res, 500, { error: "proxy_failed" });
      return;
    }
    res.end();
  }
});

server.listen(port, host, () => {
  console.log(
    `[ollama-openai-proxy] listening on http://${host}:${port} -> OpenAI ${openaiBaseUrl}`,
  );
});
