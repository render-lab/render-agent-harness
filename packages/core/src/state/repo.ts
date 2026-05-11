import type { Pool, PoolClient } from "pg";
import type {
  AgentConversation,
  AgentRun,
  ContentBlock,
  ConversationId,
  Message,
  RunCursor,
  RunId,
  RunStatus,
  SerializedError,
  TokenUsage,
  ToolCall,
  ToolCallId,
  ToolResult,
  UserId,
} from "../types.js";

const NOTIFY_CHANNEL = "agent_runs";

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
const ZERO_CURSOR: RunCursor = {
  turn: 0,
  toolCalls: 0,
  wallMs: 0,
  usage: ZERO_USAGE,
};

interface RunRow {
  id: string;
  agent_name: string;
  agent_version: string;
  status: RunStatus;
  user_id: string | null;
  conversation_id: string | null;
  cursor: RunCursor;
  total_cost_usd: string;
  metadata: Record<string, unknown>;
  final_error: SerializedError | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface MessageRow {
  id: string;
  run_id: string;
  conversation_id: string | null;
  seq: number;
  role: Message["role"];
  content: ContentBlock[];
  usage: TokenUsage | null;
  created_at: Date;
}

interface ConversationRow {
  id: string;
  user_id: string | null;
  agent_name: string;
  agent_version: string;
  title: string | null;
  metadata: Record<string, unknown>;
  total_cost_usd: string;
  created_at: Date;
  updated_at: Date;
  last_active_at: Date;
}

interface ToolCallRow {
  id: string;
  run_id: string;
  name: string;
  input: unknown;
  idempotency_key: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

interface ToolResultRow {
  tool_call_id: string;
  run_id: string;
  content: string;
  truncated_content: string;
  token_count: number;
  is_error: boolean;
  duration_ms: number;
  created_at: Date;
}

// --------------------------------------------------------------------
// Runs
// --------------------------------------------------------------------

export async function createRun(
  pool: Pool,
  args: {
    id: RunId;
    agentName: string;
    agentVersion: string;
    userId?: UserId | null;
    conversationId?: ConversationId | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AgentRun> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO agent_runs
       (id, agent_name, agent_version, status, user_id, conversation_id, metadata)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)
       RETURNING *`,
    [
      args.id,
      args.agentName,
      args.agentVersion,
      args.userId ?? null,
      args.conversationId ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  const row = expectOne(rows, "createRun");
  await notify(pool, {
    runId: row.id,
    kind: "run_created",
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
  });
  return rowToRun(row);
}

/**
 * Idempotent run insert. If a row with `id` already exists, return it
 * unchanged; otherwise insert and emit `run_created`. Single-statement
 * `ON CONFLICT (id) DO NOTHING` so two producers racing on the same runId
 * can't both insert.
 */
export async function ensureRun(
  pool: Pool,
  args: {
    id: RunId;
    agentName: string;
    agentVersion: string;
    userId?: UserId | null;
    conversationId?: ConversationId | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AgentRun> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO agent_runs
       (id, agent_name, agent_version, status, user_id, conversation_id, metadata)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
    [
      args.id,
      args.agentName,
      args.agentVersion,
      args.userId ?? null,
      args.conversationId ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  if (rows.length > 0) {
    const row = rows[0] as RunRow;
    await notify(pool, {
      runId: row.id,
      kind: "run_created",
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    });
    return rowToRun(row);
  }
  const existing = await loadRun(pool, args.id);
  if (!existing) throw new Error(`ensureRun: row vanished after ON CONFLICT for ${args.id}`);
  return existing;
}

export async function loadRun(pool: Pool, runId: RunId): Promise<AgentRun | null> {
  const { rows } = await pool.query<RunRow>("SELECT * FROM agent_runs WHERE id = $1", [runId]);
  const row = rows[0];
  return row ? rowToRun(row) : null;
}

export async function loadRunForUser(
  pool: Pool,
  runId: RunId,
  userId: UserId,
): Promise<AgentRun | null> {
  const { rows } = await pool.query<RunRow>(
    "SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2",
    [runId, userId],
  );
  const row = rows[0];
  return row ? rowToRun(row) : null;
}

export async function setRunStatus(
  pool: Pool,
  runId: RunId,
  status: RunStatus,
  opts?: { error?: SerializedError; finalize?: boolean },
): Promise<void> {
  const now = new Date();
  const finalize = opts?.finalize ?? ["completed", "failed", "cancelled"].includes(status);
  const { rows } = await pool.query<{ conversation_id: string | null }>(
    `UPDATE agent_runs
       SET status = $2,
           updated_at = $3::timestamptz,
           started_at = COALESCE(
             started_at,
             CASE WHEN $2 = 'running' THEN $3::timestamptz END
           ),
           finished_at = CASE WHEN $4 THEN $3::timestamptz ELSE finished_at END,
           final_error = COALESCE($5::jsonb, final_error)
       WHERE id = $1
       RETURNING conversation_id`,
    [runId, status, now, finalize, opts?.error ? JSON.stringify(opts.error) : null],
  );
  const conversationId = rows[0]?.conversation_id ?? null;
  await notify(pool, {
    runId,
    kind: "run_status",
    status,
    ...(conversationId ? { conversationId } : {}),
  });
  // Keep the conversation rollup (cost, last_active_at) fresh after every
  // status flip on a run that belongs to one. Cheap — the SUM is over the
  // handful of runs in this conversation.
  if (conversationId) {
    await rollupConversation(pool, conversationId);
  }
}

/**
 * Shallow-merge keys into `runs.metadata`. Used by the agent loop to stash
 * per-run flags (e.g. `pauseReason: "awaiting_input"`) without overwriting
 * metadata the runtime set when the run was created.
 */
export async function mergeRunMetadata(
  pool: Pool,
  runId: RunId,
  patch: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       WHERE id = $1`,
    [runId, JSON.stringify(patch)],
  );
}

export async function updateRunCursor(
  pool: Pool,
  runId: RunId,
  cursor: RunCursor,
  totalCostUsd: number,
): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
       SET cursor = $2::jsonb,
           total_cost_usd = $3,
           updated_at = now()
       WHERE id = $1`,
    [runId, JSON.stringify(cursor), totalCostUsd],
  );
}

// --------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------

export async function appendMessage(
  pool: Pool,
  msg: Omit<Message, "id" | "createdAt"> & {
    id?: string;
    runId: RunId;
    /**
     * When set, this message is also tagged with the conversation id so
     * `loadConversationMessages` can fetch the full history without joining
     * back to `agent_runs`. Pass `run.conversationId` from the loop.
     */
    conversationId?: ConversationId | null;
  },
): Promise<Message> {
  const id = msg.id ?? cryptoRandomId();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seqRes = await client.query<{ seq: number }>("SELECT agent_next_seq($1) AS seq", [
      msg.runId,
    ]);
    const seq = seqRes.rows[0]?.seq ?? 1;
    const { rows } = await client.query<MessageRow>(
      `INSERT INTO agent_messages
         (id, run_id, conversation_id, seq, role, content, usage)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         RETURNING *`,
      [
        id,
        msg.runId,
        msg.conversationId ?? null,
        seq,
        msg.role,
        JSON.stringify(msg.content),
        msg.usage ? JSON.stringify(msg.usage) : null,
      ],
    );
    await client.query("COMMIT");
    const row = expectOne(rows, "appendMessage");
    await notify(pool, {
      runId: msg.runId,
      kind: "message",
      messageId: row.id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    });
    return rowToMessage(row);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listMessages(pool: Pool, runId: RunId): Promise<Message[]> {
  const { rows } = await pool.query<MessageRow>(
    "SELECT * FROM agent_messages WHERE run_id = $1 ORDER BY seq ASC",
    [runId],
  );
  return rows.map(rowToMessage);
}

/**
 * Fetch a single message by id. Used by the SSE handler so we don't reload the
 * full run history on every NOTIFY.
 */
export async function loadMessage(pool: Pool, messageId: string): Promise<Message | null> {
  const { rows } = await pool.query<MessageRow>(
    "SELECT * FROM agent_messages WHERE id = $1",
    [messageId],
  );
  return rows.length > 0 ? rowToMessage(rows[0] as MessageRow) : null;
}

export async function countRunMessages(pool: Pool, runId: RunId): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM agent_messages WHERE run_id = $1",
    [runId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Append `content` as the run's first user message — but only if the run has
 * no messages yet. No-op when content is empty or the run already has messages.
 * Used by producers (workflows trigger, web /input) to initialize a run that
 * the consumer will pick up later.
 */
export async function ensureInitialMessage(
  pool: Pool,
  args: {
    runId: RunId;
    content: ContentBlock[];
    conversationId?: ConversationId | null;
  },
): Promise<void> {
  if (!args.content || args.content.length === 0) return;
  const count = await countRunMessages(pool, args.runId);
  if (count > 0) return;
  await appendMessage(pool, {
    runId: args.runId,
    role: "user",
    content: args.content,
    conversationId: args.conversationId ?? null,
  });
}

export interface ListRunsFilter {
  /** Restrict to runs owned by this user. */
  userId?: UserId;
  /** Restrict to one or more agent names. */
  agentName?: string | string[];
  /** Restrict to one or more statuses. */
  status?: RunStatus | RunStatus[];
  /** Page size; defaults to 50, capped at 200. */
  limit?: number;
  /**
   * Keyset cursor: opaque string returned by the previous page. Internally
   * encodes `(createdAt, id)` of the last row so we can paginate without
   * counting offsets.
   */
  cursor?: string;
}

export interface ListRunsPage {
  runs: AgentRun[];
  /** Pass back as `cursor` to fetch the next page. `null` when no more. */
  nextCursor: string | null;
}

const RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * List runs newest-first with optional status / agent / user filters and
 * keyset pagination over `(created_at DESC, id DESC)`.
 *
 * Used by the operator UI's runs list. Don't call this in the hot path of
 * the agent loop — it's a read-side API and not optimised for that.
 */
export async function listRuns(pool: Pool, filter: ListRunsFilter = {}): Promise<ListRunsPage> {
  const limit = clampLimit(filter.limit);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.userId !== undefined) {
    params.push(filter.userId);
    where.push(`user_id = $${params.length}`);
  }
  const agentNames = toArray(filter.agentName).filter((s) => s.length > 0);
  if (agentNames.length > 0) {
    params.push(agentNames);
    where.push(`agent_name = ANY($${params.length}::text[])`);
  }
  const statuses = toArray(filter.status).filter((s): s is RunStatus => RUN_STATUSES.has(s));
  if (statuses.length > 0) {
    params.push(statuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }

  const cursor = decodeCursor(filter.cursor);
  if (cursor) {
    params.push(cursor.createdAt.toISOString(), cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // Fetch limit+1 to see whether there's another page.
  params.push(limit + 1);
  const sql = `
    SELECT * FROM agent_runs
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query<RunRow>(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
  return { runs: page.map(rowToRun), nextCursor };
}

function clampLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) && typeof raw === "number" ? Math.floor(raw) : 50;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface RunCursorKey {
  createdAt: Date;
  id: string;
}

function encodeCursor(key: RunCursorKey): string {
  return Buffer.from(JSON.stringify({ t: key.createdAt.toISOString(), i: key.id })).toString(
    "base64url",
  );
}

function decodeCursor(raw: string | undefined): RunCursorKey | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string") return null;
    const d = new Date(parsed.t);
    if (Number.isNaN(d.getTime())) return null;
    return { createdAt: d, id: parsed.i };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------
// Conversations
// --------------------------------------------------------------------

export async function createConversation(
  pool: Pool,
  args: {
    id?: ConversationId;
    userId?: UserId | null;
    agentName: string;
    agentVersion: string;
    title?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<AgentConversation> {
  const id = args.id ?? cryptoRandomId();
  const { rows } = await pool.query<ConversationRow>(
    `INSERT INTO agent_conversations
       (id, user_id, agent_name, agent_version, title, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
    [
      id,
      args.userId ?? null,
      args.agentName,
      args.agentVersion,
      args.title ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return rowToConversation(expectOne(rows, "createConversation"));
}

export async function loadConversation(
  pool: Pool,
  id: ConversationId,
): Promise<AgentConversation | null> {
  const { rows } = await pool.query<ConversationRow>(
    "SELECT * FROM agent_conversations WHERE id = $1",
    [id],
  );
  const row = rows[0];
  return row ? rowToConversation(row) : null;
}

export async function loadConversationForUser(
  pool: Pool,
  id: ConversationId,
  userId: UserId,
): Promise<AgentConversation | null> {
  const { rows } = await pool.query<ConversationRow>(
    "SELECT * FROM agent_conversations WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  const row = rows[0];
  return row ? rowToConversation(row) : null;
}

export interface ListConversationsFilter {
  userId?: UserId;
  agentName?: string | string[];
  limit?: number;
  /** Keyset cursor opaquely encoding `(last_active_at, id)` of the last row. */
  cursor?: string;
}

export interface ListConversationsPage {
  conversations: AgentConversation[];
  nextCursor: string | null;
}

export async function listConversations(
  pool: Pool,
  filter: ListConversationsFilter = {},
): Promise<ListConversationsPage> {
  const limit = clampLimit(filter.limit);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.userId !== undefined) {
    params.push(filter.userId);
    where.push(`user_id = $${params.length}`);
  }
  const agentNames = toArray(filter.agentName).filter((s) => s.length > 0);
  if (agentNames.length > 0) {
    params.push(agentNames);
    where.push(`agent_name = ANY($${params.length}::text[])`);
  }

  const cursor = decodeCursor(filter.cursor);
  if (cursor) {
    params.push(cursor.createdAt.toISOString(), cursor.id);
    where.push(
      `(last_active_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`,
    );
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit + 1);
  const sql = `
    SELECT * FROM agent_conversations
    ${whereSql}
    ORDER BY last_active_at DESC, id DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query<ConversationRow>(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.last_active_at, id: last.id }) : null;
  return { conversations: page.map(rowToConversation), nextCursor };
}

/**
 * Load every message in a conversation in turn order. The loop calls this
 * instead of `listMessages(runId)` when the run belongs to a conversation,
 * so the model sees full multi-turn history across all the runs in this
 * conversation. Ordered by `created_at, seq` — `seq` is per-run, so
 * `created_at` is the primary key and `seq` is the tie-breaker within a
 * single run.
 */
export async function loadConversationMessages(
  pool: Pool,
  conversationId: ConversationId,
): Promise<Message[]> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT * FROM agent_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, seq ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

/**
 * Return the active (non-terminal) run for a conversation, if any. Used by
 * `POST /conversations/:id/messages` to enforce the sequential-only
 * invariant (returns 409 when this finds a row).
 */
export async function findActiveRunForConversation(
  pool: Pool,
  conversationId: ConversationId,
): Promise<AgentRun | null> {
  const { rows } = await pool.query<RunRow>(
    `SELECT * FROM agent_runs
      WHERE conversation_id = $1
        AND status IN ('pending','running','paused')
      ORDER BY created_at DESC
      LIMIT 1`,
    [conversationId],
  );
  const row = rows[0];
  return row ? rowToRun(row) : null;
}

/**
 * Bump a conversation's denormalised rollup fields. Called from the loop
 * when a run that belongs to the conversation reaches a terminal state.
 * Idempotent on caller side — pass the run's *full* `total_cost_usd`, not
 * a delta, and `agent_conversations.total_cost_usd` is recomputed from
 * `agent_runs` in the same statement to stay correct under retries.
 */
export async function rollupConversation(
  pool: Pool,
  conversationId: ConversationId,
): Promise<void> {
  await pool.query(
    `UPDATE agent_conversations c
       SET total_cost_usd = COALESCE(
             (SELECT SUM(total_cost_usd) FROM agent_runs WHERE conversation_id = c.id),
             0
           ),
           last_active_at = now(),
           updated_at = now()
     WHERE c.id = $1`,
    [conversationId],
  );
}

// --------------------------------------------------------------------
// Tool calls
// --------------------------------------------------------------------

export async function recordToolCall(
  pool: Pool,
  call: Omit<ToolCall, "createdAt">,
): Promise<{ inserted: boolean; id: ToolCallId }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_tool_calls (id, run_id, name, input, idempotency_key, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
       ON CONFLICT (run_id, idempotency_key) DO NOTHING
       RETURNING id`,
    [call.id, call.runId, call.name, JSON.stringify(call.input), call.idempotencyKey],
  );
  return { inserted: rows.length > 0, id: call.id };
}

export async function findExistingToolCall(
  pool: Pool,
  runId: RunId,
  idempotencyKey: string,
): Promise<{ call: ToolCall; result: ToolResult | null } | null> {
  const { rows } = await pool.query<ToolCallRow>(
    `SELECT * FROM agent_tool_calls WHERE run_id = $1 AND idempotency_key = $2`,
    [runId, idempotencyKey],
  );
  const callRow = rows[0];
  if (!callRow) return null;
  const result = await loadToolResult(pool, callRow.id);
  return { call: rowToToolCall(callRow), result };
}

export async function setToolCallStatus(
  pool: Pool,
  toolCallId: ToolCallId,
  status: ToolCallRow["status"],
  opts?: { startedAt?: Date; finishedAt?: Date },
): Promise<void> {
  await pool.query(
    `UPDATE agent_tool_calls
       SET status = $2,
           started_at = COALESCE(
             $3::timestamptz,
             started_at,
             CASE WHEN $2 = 'running' THEN now() END
           ),
           finished_at = COALESCE(
             $4::timestamptz,
             finished_at,
             CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() END
           )
       WHERE id = $1`,
    [toolCallId, status, opts?.startedAt ?? null, opts?.finishedAt ?? null],
  );
}

export async function recordToolResult(
  pool: Pool,
  result: Omit<ToolResult, "createdAt">,
): Promise<ToolResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ToolResultRow>(
      `INSERT INTO agent_tool_results
         (tool_call_id, run_id, content, truncated_content, token_count, is_error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tool_call_id) DO UPDATE
         SET content = EXCLUDED.content,
             truncated_content = EXCLUDED.truncated_content,
             token_count = EXCLUDED.token_count,
             is_error = EXCLUDED.is_error,
             duration_ms = EXCLUDED.duration_ms
       RETURNING *`,
      [
        result.toolCallId,
        result.runId,
        result.content,
        result.truncatedContent,
        result.tokenCount,
        result.isError,
        result.durationMs,
      ],
    );
    await client.query(
      `UPDATE agent_tool_calls
         SET status = $2, finished_at = COALESCE(finished_at, now())
         WHERE id = $1`,
      [result.toolCallId, result.isError ? "failed" : "completed"],
    );
    await client.query("COMMIT");
    return rowToToolResult(expectOne(rows, "recordToolResult"));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function loadToolResult(
  pool: Pool,
  toolCallId: ToolCallId,
): Promise<ToolResult | null> {
  const { rows } = await pool.query<ToolResultRow>(
    "SELECT * FROM agent_tool_results WHERE tool_call_id = $1",
    [toolCallId],
  );
  const row = rows[0];
  return row ? rowToToolResult(row) : null;
}

export interface ToolCallWithResult {
  call: ToolCall & {
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    startedAt: Date | null;
    finishedAt: Date | null;
  };
  result: ToolResult | null;
}

/**
 * List every tool call for a run, joined to its result if one exists. Used
 * by the operator UI to render a tool timeline distinct from the message
 * stream. Ordered by `created_at ASC` so it interleaves cleanly with
 * messages.
 */
export async function listToolCalls(pool: Pool, runId: RunId): Promise<ToolCallWithResult[]> {
  const { rows } = await pool.query<
    ToolCallRow & {
      r_content: string | null;
      r_truncated_content: string | null;
      r_token_count: number | null;
      r_is_error: boolean | null;
      r_duration_ms: number | null;
      r_created_at: Date | null;
    }
  >(
    `SELECT c.id, c.run_id, c.name, c.input, c.idempotency_key, c.status,
            c.started_at, c.finished_at, c.created_at,
            r.content              AS r_content,
            r.truncated_content    AS r_truncated_content,
            r.token_count          AS r_token_count,
            r.is_error             AS r_is_error,
            r.duration_ms          AS r_duration_ms,
            r.created_at           AS r_created_at
       FROM agent_tool_calls c
       LEFT JOIN agent_tool_results r ON r.tool_call_id = c.id
      WHERE c.run_id = $1
      ORDER BY c.created_at ASC`,
    [runId],
  );

  return rows.map((row) => {
    const call = {
      ...rowToToolCall(row),
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
    const result: ToolResult | null =
      row.r_content !== null &&
      row.r_truncated_content !== null &&
      row.r_token_count !== null &&
      row.r_is_error !== null &&
      row.r_duration_ms !== null &&
      row.r_created_at !== null
        ? {
            toolCallId: row.id,
            runId: row.run_id,
            content: row.r_content,
            truncatedContent: row.r_truncated_content,
            tokenCount: row.r_token_count,
            isError: row.r_is_error,
            durationMs: row.r_duration_ms,
            createdAt: row.r_created_at,
          }
        : null;
    return { call, result };
  });
}

// --------------------------------------------------------------------
// Aggregations (read-side, used by the operator UI usage tab)
// --------------------------------------------------------------------

export interface UsageRollupRow {
  /** Day bucket as ISO date (UTC, "YYYY-MM-DD"). */
  day: string;
  agentName: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AggregateUsageOpts {
  /** Inclusive lower bound on `created_at`. Defaults to 30 days ago. */
  from?: Date;
  /** Exclusive upper bound on `created_at`. Defaults to "now". */
  to?: Date;
  /** Optional user filter. */
  userId?: UserId;
}

/**
 * Daily per-agent rollup of run count, cost, and token usage. Token usage
 * comes from `agent_runs.cursor->'usage'` which the loop keeps up to date
 * as the run progresses, so we don't need a join against the messages
 * table for the typical view.
 */
export async function aggregateUsage(
  pool: Pool,
  opts: AggregateUsageOpts = {},
): Promise<UsageRollupRow[]> {
  const to = opts.to ?? new Date();
  const from = opts.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const params: unknown[] = [from, to];
  let userClause = "";
  if (opts.userId !== undefined) {
    params.push(opts.userId);
    userClause = `AND user_id = $${params.length}`;
  }

  const { rows } = await pool.query<{
    day: string;
    agent_name: string;
    runs: string;
    cost_usd: string;
    input_tokens: string;
    output_tokens: string;
  }>(
    `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            agent_name,
            COUNT(*)::text AS runs,
            COALESCE(SUM(total_cost_usd), 0)::text AS cost_usd,
            COALESCE(SUM((cursor->'usage'->>'inputTokens')::bigint), 0)::text AS input_tokens,
            COALESCE(SUM((cursor->'usage'->>'outputTokens')::bigint), 0)::text AS output_tokens
       FROM agent_runs
      WHERE created_at >= $1::timestamptz
        AND created_at <  $2::timestamptz
        ${userClause}
      GROUP BY day, agent_name
      ORDER BY day DESC, agent_name ASC`,
    params,
  );
  return rows.map((row) => ({
    day: row.day,
    agentName: row.agent_name,
    runs: Number(row.runs),
    costUsd: Number(row.cost_usd),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  }));
}

// --------------------------------------------------------------------
// LISTEN/NOTIFY
// --------------------------------------------------------------------

/**
 * Pointer-over-NOTIFY payload. `conversationId` is set on every variant
 * when the originating run belongs to a conversation, so the conversation
 * SSE stream can fan in across runs without joining `agent_runs` per event.
 * Optional everywhere to keep single-turn / cron one-shot payloads compact.
 */
export type NotifyPayload =
  | { runId: string; kind: "run_created"; conversationId?: string }
  | { runId: string; kind: "run_status"; status: RunStatus; conversationId?: string }
  | { runId: string; kind: "message"; messageId: string; conversationId?: string }
  | { runId: string; kind: "tool_call"; toolCallId: string; conversationId?: string }
  | { runId: string; kind: "tool_result"; toolCallId: string; conversationId?: string };

async function notify(pool: Pool, payload: NotifyPayload): Promise<void> {
  // Payload is small (pointer-sized) and always under the 8 KB NOTIFY cap.
  await pool.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify(payload)]);
}

export const STREAM_NOTIFY_CHANNEL = NOTIFY_CHANNEL;

// --------------------------------------------------------------------
// Row → domain mappers
// --------------------------------------------------------------------

function rowToRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    agentName: row.agent_name,
    agentVersion: row.agent_version,
    status: row.status,
    userId: row.user_id,
    conversationId: row.conversation_id,
    cursor: row.cursor ?? ZERO_CURSOR,
    totalCostUsd: Number(row.total_cost_usd ?? 0),
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function rowToConversation(row: ConversationRow): AgentConversation {
  return {
    id: row.id,
    userId: row.user_id,
    agentName: row.agent_name,
    agentVersion: row.agent_version,
    title: row.title,
    metadata: row.metadata ?? {},
    totalCostUsd: Number(row.total_cost_usd ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    ...(row.usage ? { usage: row.usage } : {}),
  };
}

function rowToToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    input: row.input,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function rowToToolResult(row: ToolResultRow): ToolResult {
  return {
    toolCallId: row.tool_call_id,
    runId: row.run_id,
    content: row.content,
    truncatedContent: row.truncated_content,
    tokenCount: row.token_count,
    isError: row.is_error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function expectOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${op}: expected one row, got none`);
  return row;
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
