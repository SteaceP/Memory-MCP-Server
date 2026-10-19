import type { Env } from "./env";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dims, must match the Vectorize index
/** Semantic hits below this cosine similarity are treated as noise (keyword hits bypass it). */
const MIN_SIMILARITY = 0.55;
/** A new fact at least this similar to an existing one is merged into it instead of duplicated. */
const DUPLICATE_SIMILARITY = 0.95;
/** Reciprocal Rank Fusion damping constant (standard value). */
const RRF_K = 60;
/** Per-source candidate cap. 2 sources x 40 ids + 10 tags stays under D1's 100 bound-parameter limit. */
const MAX_CANDIDATES = 40;
/** Words too common to be useful in an OR'ed keyword query. */
const STOPWORDS = new Set(
  "a an and are as at be but by do does for from has have how i in is it its me my of on or our so that the their them they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Cosine similarity for semantic hits; undefined for keyword-only hits and plain listings. */
  score?: number;
}

interface Row {
  id: number;
  content: string;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT = `SELECT m.id, m.content, m.created_at, m.updated_at,
  (SELECT group_concat(tag, ',') FROM memory_tags t WHERE t.memory_id = m.id) AS tags
FROM memories m`;

const placeholders = (n: number) => Array(n).fill("?").join(",");
const tagFilter = (n: number) => `m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders(n)}))`;

const toMemory = (r: Row): Memory => ({
  id: r.id,
  content: r.content,
  tags: r.tags ? r.tags.split(",").sort() : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Lowercase, hyphenate whitespace, strip commas (used as a separator), dedupe. */
export function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/[\s,]+/g, "-")).filter(Boolean))];
}

/** Compact one-line rendering: `#42 .87 2026-10-19 [work,pref] text`. */
export function formatMemory(m: Memory, withScore = false): string {
  const parts = [`#${m.id}`];
  if (withScore) parts.push(m.score === undefined ? "kw" : m.score.toFixed(2).replace(/^0/, ""));
  parts.push(new Date(m.updatedAt * 1000).toISOString().slice(0, 10));
  if (m.tags.length) parts.push(`[${m.tags.join(",")}]`);
  parts.push(m.content.replace(/\s*\n\s*/g, " ↵ "));
  return parts.join(" ");
}

export class MemoryStore {
  constructor(private readonly env: Env) {}

  private get db() {
    return this.env.DB;
  }

  private async embed(text: string): Promise<number[]> {
    const res = (await this.env.AI.run(EMBED_MODEL, { text: [text], pooling: "cls" })) as { data?: number[][] };
    const vector = res.data?.[0];
    if (!vector) throw new Error("Embedding model returned no vector");
    return vector;
  }

  private async exists(id: number): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 FROM memories WHERE id = ?").bind(id).first()) !== null;
  }

  private insertTagStmts(id: number | null, tags: string[]): D1PreparedStatement[] {
    // id === null => attach to the row inserted earlier in the same batch.
    const sql =
      id === null
        ? "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (last_insert_rowid(), ?)"
        : "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)";
    return tags.map((t) => (id === null ? this.db.prepare(sql).bind(t) : this.db.prepare(sql).bind(id, t)));
  }

  /** Stores a fact, or merges tags into an existing near-identical memory. */
  async remember(content: string, rawTags?: string[]): Promise<{ id: number; duplicateScore?: number }> {
    const tags = normalizeTags(rawTags);
    const vector = await this.embed(content);

    const [top] = (await this.env.VECTORIZE.query(vector, { topK: 1 })).matches;
    if (top && top.score >= DUPLICATE_SIMILARITY) {
      const id = Number(top.id);
      if (await this.exists(id)) {
        if (tags.length) {
          await this.db.batch([
            ...this.insertTagStmts(id, tags),
            this.db.prepare("UPDATE memories SET updated_at = unixepoch() WHERE id = ?").bind(id),
          ]);
        }
        return { id, duplicateScore: top.score };
      }
    }

    // Single transaction: row + tags. memory_tags is WITHOUT ROWID, so last_insert_rowid() stays on the memory row.
    const [inserted] = await this.db.batch<{ id: number }>([
      this.db.prepare("INSERT INTO memories (content) VALUES (?) RETURNING id").bind(content),
      ...this.insertTagStmts(null, tags),
    ]);
    const id = inserted.results[0].id;

    try {
      await this.env.VECTORIZE.upsert([{ id: String(id), values: vector }]);
    } catch (err) {
      await this.deleteRows([id]); // keep D1 and Vectorize consistent
      throw err;
    }
    return { id };
  }

  /** Hybrid recall: Vectorize similarity + FTS5 keywords, merged with Reciprocal Rank Fusion. */
  async search(query: string, opts: { tags?: string[]; limit: number }): Promise<Memory[]> {
    const tags = normalizeTags(opts.tags);
    // Over-fetch when filtering by tag, since filtering happens after candidate retrieval.
    const k = Math.min(MAX_CANDIDATES, opts.limit * (tags.length ? 5 : 2));

    const [semantic, keyword] = await Promise.all([
      this.embed(query).then((v) => this.env.VECTORIZE.query(v, { topK: k })),
      this.keywordSearch(query, k),
    ]);

    const fused = new Map<number, number>();
    const similarity = new Map<number, number>();
    const addRank = (id: number, rank: number) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank));

    semantic.matches
      .filter((m) => m.score >= MIN_SIMILARITY)
      .forEach((m, rank) => {
        const id = Number(m.id);
        similarity.set(id, m.score);
        addRank(id, rank);
      });
    keyword.forEach(addRank);
    if (!fused.size) return [];

    const ids = [...fused.keys()];
    let sql = `${SELECT} WHERE m.id IN (${placeholders(ids.length)})`;
    if (tags.length) sql += ` AND ${tagFilter(tags.length)}`;
    const { results } = await this.db
      .prepare(sql)
      .bind(...ids, ...tags)
      .all<Row>();

    return results
      .map((r) => ({ ...toMemory(r), score: similarity.get(r.id) }))
      .sort((a, b) => fused.get(b.id)! - fused.get(a.id)!)
      .slice(0, opts.limit);
  }

  private async keywordSearch(query: string, k: number): Promise<number[]> {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter((t) => !STOPWORDS.has(t));
    if (!terms.length) return [];
    const match = terms
      .slice(0, 12)
      .map((t) => `"${t}"`)
      .join(" OR ");
    try {
      const { results } = await this.db
        .prepare("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?")
        .bind(match, k)
        .all<{ id: number }>();
      return results.map((r) => r.id);
    } catch (err) {
      console.warn("Keyword search failed; falling back to semantic only", err);
      return [];
    }
  }

  /** Newest-first keyset pagination. `next` is the cursor for the following page. */
  async list(opts: { tags?: string[]; limit: number; cursor?: number }): Promise<{ items: Memory[]; next?: number }> {
    const tags = normalizeTags(opts.tags);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.cursor) {
      where.push("m.id < ?");
      params.push(opts.cursor);
    }
    if (tags.length) {
      where.push(tagFilter(tags.length));
      params.push(...tags);
    }
    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY m.id DESC LIMIT ?`;
    const { results } = await this.db
      .prepare(sql)
      .bind(...params, opts.limit + 1)
      .all<Row>();

    const items = results.slice(0, opts.limit).map(toMemory);
    return { items, next: results.length > opts.limit ? items[items.length - 1].id : undefined };
  }

  /** Returns false if the memory doesn't exist. `rawTags` replaces all tags when provided. */
  async update(id: number, content?: string, rawTags?: string[]): Promise<boolean> {
    if (!(await this.exists(id))) return false;
    const vector = content ? await this.embed(content) : undefined;

    const stmts: D1PreparedStatement[] = [
      content
        ? this.db.prepare("UPDATE memories SET content = ?, updated_at = unixepoch() WHERE id = ?").bind(content, id)
        : this.db.prepare("UPDATE memories SET updated_at = unixepoch() WHERE id = ?").bind(id),
    ];
    if (rawTags) {
      stmts.push(this.db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").bind(id));
      stmts.push(...this.insertTagStmts(id, normalizeTags(rawTags)));
    }
    await this.db.batch(stmts);

    if (vector) await this.env.VECTORIZE.upsert([{ id: String(id), values: vector }]);
    return true;
  }

  /** Deletes memories and their vectors. Returns the ids that actually existed. */
  async forget(ids: number[]): Promise<number[]> {
    const deleted = await this.deleteRows([...new Set(ids)]);
    if (deleted.length) await this.env.VECTORIZE.deleteByIds(deleted.map(String));
    return deleted;
  }

  private async deleteRows(ids: number[]): Promise<number[]> {
    if (!ids.length) return [];
    const marks = placeholders(ids.length);
    const [, removed] = await this.db.batch<{ id: number }>([
      this.db.prepare(`DELETE FROM memory_tags WHERE memory_id IN (${marks})`).bind(...ids),
      this.db.prepare(`DELETE FROM memories WHERE id IN (${marks}) RETURNING id`).bind(...ids),
    ]);
    return removed.results.map((r) => r.id).sort((a, b) => a - b);
  }

  async tagCounts(): Promise<{ tag: string; count: number }[]> {
    const { results } = await this.db
      .prepare("SELECT tag, count(*) AS count FROM memory_tags GROUP BY tag ORDER BY count DESC, tag")
      .all<{ tag: string; count: number }>();
    return results;
  }
}
