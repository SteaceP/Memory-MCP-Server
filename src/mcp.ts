import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, SERVER_NAME, SERVER_VERSION } from "./env";
import { formatMemory, MemoryStore } from "./store";

// Descriptions are deliberately terse: every tool/param description is sent to the model on each session.
const INSTRUCTIONS =
  "Persistent memory across sessions. Use recall_memories when past user/project context may help; " +
  "use remember_fact for durable facts, preferences and decisions (not transient chatter). " +
  "Result lines: #id [score] date [tags] text.";

const fact = z.string().trim().min(1).max(4000);
const tags = z.array(z.string().trim().min(1).max(32)).max(10);
const memoryId = z.number().int().positive();

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

/** Runs a tool body, converting thrown errors into MCP tool errors the model can read and recover from. */
async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    console.error("Tool error", err);
    return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
  }
}

const ids = (list: number[]) => list.map((id) => `#${id}`).join(",");

export function createServer(env: Env): McpServer {
  const store = new MemoryStore(env);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  // ── Tools ────────────────────────────────────────────────────────────────

  server.registerTool(
    "remember_fact",
    {
      title: "Remember fact",
      description: "Store a durable fact. Near-duplicates merge into the existing memory.",
      inputSchema: z.object({ fact, tags: tags.optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ fact, tags }) =>
      run(async () => {
        const { id, duplicateScore } = await store.remember(fact.trim(), tags);
        return duplicateScore === undefined ? `Saved #${id}` : `Exists #${id} (${duplicateScore.toFixed(2)})`;
      }),
  );

  server.registerTool(
    "recall_memories",
    {
      title: "Recall memories",
      description: "Hybrid semantic+keyword search. Score 'kw' = keyword-only match.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500),
        tags: tags.optional().describe("Match any"),
        limit: z.number().int().min(1).max(20).optional().describe("Default 5"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tags, limit }) =>
      run(async () => {
        const hits = await store.search(query, { tags, limit: limit ?? 5 });
        return hits.length ? hits.map((m) => formatMemory(m, true)).join("\n") : "No matches";
      }),
  );

  server.registerTool(
    "list_memories",
    {
      title: "List memories",
      description: "List memories newest first.",
      inputSchema: z.object({
        tags: tags.optional().describe("Match any"),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
        cursor: memoryId.optional().describe("'next' from previous page"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ tags, limit, cursor }) =>
      run(async () => {
        const { items, next } = await store.list({ tags, limit: limit ?? 20, cursor });
        if (!items.length) return "No memories";
        const lines = items.map((m) => formatMemory(m));
        if (next) lines.push(`next: ${next}`);
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description: "Edit a memory's text and/or tags.",
      inputSchema: z.object({ id: memoryId, fact: fact.optional(), tags: tags.optional().describe("Replaces all tags") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, fact, tags }) =>
      run(async () => {
        if (fact === undefined && tags === undefined) throw new Error("Provide fact and/or tags");
        if (!(await store.update(id, fact?.trim(), tags))) throw new Error(`#${id} not found`);
        return `Updated #${id}`;
      }),
  );

  server.registerTool(
    "forget_memory",
    {
      title: "Forget memory",
      description: "Permanently delete memories by id.",
      inputSchema: z.object({ ids: z.array(memoryId).min(1).max(50) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids: requested }) =>
      run(async () => {
        const deleted = await store.forget(requested);
        const missing = [...new Set(requested)].filter((id) => !deleted.includes(id));
        const parts = [];
        if (deleted.length) parts.push(`Deleted ${ids(deleted)}`);
        if (missing.length) parts.push(`Not found ${ids(missing)}`);
        return parts.join("; ");
      }),
  );

  // ── Resources ────────────────────────────────────────────────────────────

  server.registerResource(
    "tags",
    "memory://tags",
    { title: "Memory tags", description: "All tags with memory counts", mimeType: "text/plain" },
    async (uri) => {
      const counts = await store.tagCounts();
      const body = counts.map((t) => `${t.tag} ${t.count}`).join("\n") || "No tags";
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: body }] };
    },
  );

  server.registerResource(
    "memories-by-tag",
    new ResourceTemplate("memory://tags/{tag}", {
      list: async () => ({
        resources: (await store.tagCounts()).map((t) => ({
          uri: `memory://tags/${encodeURIComponent(t.tag)}`,
          name: t.tag,
          description: `${t.count} memories`,
          mimeType: "text/plain",
        })),
      }),
      complete: {
        tag: async (value) => {
          const prefix = value.toLowerCase();
          return (await store.tagCounts())
            .map((t) => t.tag)
            .filter((t) => t.startsWith(prefix))
            .slice(0, 20);
        },
      },
    }),
    { title: "Memories by tag", description: "Memories with a tag, newest first", mimeType: "text/plain" },
    async (uri, { tag }) => {
      const name = decodeURIComponent(String(Array.isArray(tag) ? tag[0] : tag));
      const { items, next } = await store.list({ tags: [name], limit: 100 });
      const lines = items.map((m) => formatMemory(m));
      if (next) lines.push(`… more via list_memories cursor ${next}`);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") || "No memories" }] };
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────────────

  server.registerPrompt(
    "recall_context",
    {
      title: "Recall context",
      description: "Preload memories relevant to a topic (no tool round-trip)",
      argsSchema: z.object({ topic: z.string().describe("Topic or question") }),
    },
    async ({ topic }) => {
      const hits = await store.search(topic, { limit: 8 });
      const body = hits.length
        ? `Relevant memories for "${topic}":\n${hits.map((m) => formatMemory(m, true)).join("\n")}\n\n` +
          "Use these as context. Save new durable facts with remember_fact; fix stale ones with update_memory."
        : `No stored memories match "${topic}". Save durable facts you learn with remember_fact.`;
      return { messages: [{ role: "user", content: { type: "text", text: body } }] };
    },
  );

  return server;
}
