# Remote MCP Memory Server

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server deployed on [Cloudflare Workers](https://workers.cloudflare.com/). It provides persistent, long-term memory for AI agents and assistants, backed by Cloudflare D1 (relational SQL) and Cloudflare Vectorize (vector database for semantic search).

---

## Features

- **Standard MCP Over HTTP**: Utilizes `@modelcontextprotocol/server` with `createMcpHandler`, supporting both modern (2026-07-28) protocol revision and legacy (2025/2024-11-05) clients natively compatible with Cloudflare Workers' `fetch` handler. Served at `/` and `/mcp`.
- **Secure Authentication**: Constant-time Bearer token verification via the `Authorization: Bearer <API_AUTH_TOKEN>` header (fails closed if the secret is missing).
- **Edge Performance**: Powered by Cloudflare Workers for ultra-low latency worldwide.
- **Hybrid Recall**: Semantic search (Workers AI `@cf/baai/bge-base-en-v1.5` + Vectorize) fused with keyword search (D1 FTS5) via Reciprocal Rank Fusion. Keyword search also covers the few seconds before new vectors become queryable.
- **Dedup on Write**: Facts ≥ 0.95 similar to an existing memory are merged (tags added) instead of duplicated.
- **Token-Efficient**: Terse tool descriptions, short integer IDs (`#42`), and compact one-line results.
- **Hardened HTTP**: CORS + optional origin allow-list, `/health` probe, JSON-RPC shaped errors, `405` for unsupported methods.
- **Hybrid Storage Architecture**:
  - **Cloudflare D1**: Stores raw memory text, tags, timestamps, and the FTS5 keyword index.
  - **Cloudflare Vectorize**: Enables vector similarity search over stored insights.

---

## Tools Exposed

All results use one compact line per memory:

```text
#42 .87 2026-10-19 [pref,ui] User prefers dark mode in editors
│   │   │          │         └ text (newlines shown as ↵)
│   │   │          └ tags
│   │   └ last updated (UTC date)
│   └ similarity (recall only; "kw" = keyword-only match)
└ memory id
```

| Tool | Inputs | Notes |
| --- | --- | --- |
| `remember_fact` | `fact` (≤4000 chars), `tags?` (≤10, ≤32 chars each) | Returns `Saved #id` or `Exists #id (score)` when merged into a near-duplicate. |
| `recall_memories` | `query` (≤500 chars), `tags?` (match any), `limit?` (1–20, default 5) | Hybrid semantic + keyword search. Read-only. |
| `list_memories` | `tags?`, `limit?` (1–50, default 20), `cursor?` | Newest first. Pass the trailing `next: N` value as `cursor` for the next page. Read-only. |
| `update_memory` | `id`, `fact?`, `tags?` (replaces all) | Re-embeds when text changes. |
| `forget_memory` | `ids` (1–50) | Permanent. Reports deleted and not-found ids. |

Tags are normalized to lowercase with spaces converted to hyphens. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, …) so clients can auto-approve reads and confirm deletes.

### Resources

- `memory://tags`: every tag with its memory count.
- `memory://tags/{tag}`: memories with that tag (listable, with tag autocompletion).

### Prompts

- `recall_context(topic)`: runs the search server-side and injects relevant memories directly into the conversation, saving a tool round-trip.

---

## Project Structure

```text
remote-mcp-memory/
├── src/
│   ├── index.ts               # Worker entry point: routing, CORS, auth, transport
│   ├── mcp.ts                 # MCP tools, resources & prompts
│   ├── store.ts               # D1 + Vectorize + Workers AI data layer, hybrid search
│   ├── http.ts                # Auth, CORS & JSON error helpers
│   └── env.ts                 # Bindings interface & server identity
├── migrations/
│   └── 0001_init.sql          # D1 schema (memories, tags, FTS5 index + triggers)
├── wrangler.toml              # Cloudflare Worker configuration & resource bindings
├── worker-configuration.d.ts  # Generated TypeScript types for Cloudflare bindings
├── tsconfig.json              # TypeScript compiler configuration
├── package.json               # Dependencies and development scripts
├── .node-version              # Node.js runtime version pinned to v24
├── .dev.vars.example          # Template for local environment secrets
├── .gitignore                 # Git ignore rules
└── README.md                  # Project documentation
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v22+ required, v24+ recommended)
- A [Cloudflare](https://dash.cloudflare.com/) account
- Wrangler CLI authenticated (`npx wrangler login`)

---

## Setup & Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Cloudflare Resources

#### Cloudflare D1 Database

Create the D1 database:

```bash
npx wrangler d1 create mcp-memory-db
```

Copy the resulting `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mcp-memory-db"
database_id = "<your-d1-database-id>"
```

Apply the schema migrations:

```bash
npm run db:migrate         # remote (production) database
npm run db:migrate:local   # local database used by `wrangler dev`
```

#### Cloudflare Vectorize Index

Create a Vectorize index. The dimensions **must be 768** to match the `@cf/baai/bge-base-en-v1.5` embedding model:

```bash
npx wrangler vectorize create mcp-memory-index --dimensions=768 --metric=cosine
```

> **Note**: An index's dimensions can't be changed. If you created it with a different size, delete and recreate it: `npx wrangler vectorize delete mcp-memory-index`.

Confirm the binding matches `wrangler.toml`:

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "mcp-memory-index"
```

#### Workers AI

No setup is needed beyond the `[ai]` binding already in `wrangler.toml`. Vectorize and Workers AI have no local simulator, so `wrangler dev` uses the real remote resources (`remote = true`) while D1 stays local.

### 3. Configure Secrets

#### Generate a Strong Random Token

You can generate a cryptographically secure 256-bit random token using either OpenSSL or Node.js:

```bash
# Using OpenSSL (recommended on Linux/macOS)
openssl rand -hex 32

# Or using Node.js (cross-platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### For Local Development

Copy the provided example secrets template to `.dev.vars` (this file is ignored by Git) and customize your token:

```bash
cp .dev.vars.example .dev.vars
```

Your `.dev.vars` file should contain:

```ini
API_AUTH_TOKEN="your-super-secure-shared-secret-token"
```

#### For Production

Store the secret securely in Cloudflare:

```bash
npx wrangler secret put API_AUTH_TOKEN
```

When prompted, enter your secret token value. Cloudflare encrypts the secret and injects it into your Worker's runtime environment (`env.API_AUTH_TOKEN`).

> **Security Note**: Never commit actual production API keys or tokens into `wrangler.toml`. All secrets must be managed via Cloudflare Secrets in production or `.dev.vars` locally.

#### Optional: Restrict Browser Origins

Non-browser MCP clients send no `Origin` header and are unaffected. To limit browser-based clients, set a comma-separated allow-list in `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://claude.ai,https://chatgpt.com"
```

#### Tuning

Search thresholds live at the top of [`src/store.ts`](src/store.ts): `MIN_SIMILARITY` (0.55, drops weak semantic hits) and `DUPLICATE_SIMILARITY` (0.95, merge threshold).

---

## Development & Deployment

### Run Locally

Start the local development server:

```bash
npm run dev
```

Wrangler will launch a local server (typically at `http://localhost:8787`). Check it with `curl http://localhost:8787/health`.

### Run Type Checking

Validate TypeScript types:

```bash
npm run typecheck
```

### Generate Cloudflare Types

Generate TypeScript definitions for bindings configured in `wrangler.toml` into `worker-configuration.d.ts`:

```bash
npm run cf-typegen
```

### Deploy to Cloudflare Workers

Deploy the worker to your Cloudflare account:

```bash
npm run deploy
```

---

## Client Configuration

To connect an AI assistant or MCP client to your remote memory server, configure the client with your worker URL and the authorization header:

```json
{
  "mcpServers": {
    "remote-memory": {
      "url": "https://remote-mcp-memory.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer your-super-secure-shared-secret-token"
      }
    }
  }
}
```

---

## License

MIT
