import type { Pool, PoolClient } from "pg";
import type {
  AgentRun,
  ContentBlock,
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
  seq: number;
  role: Message["role"];
  content: ContentBlock[];
  usage: TokenUsage | null;
  created_at: Date;
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
    metadata?: Record<string, unknown>;
  },
): Promise<AgentRun> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO agent_runs (id, agent_name, agent_version, status, user_id, metadata)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING *`,
    [
      args.id,
      args.agentName,
      args.agentVersion,
      args.userId ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  const row = expectOne(rows, "createRun");
  await notify(pool, { runId: row.id, kind: "run_created" });
  return rowToRun(row);
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
  await pool.query(
    `UPDATE agent_runs
       SET status = $2,
           updated_at = $3,
           started_at = COALESCE(started_at, CASE WHEN $2 = 'running' THEN $3 ELSE NULL END),
           finished_at = CASE WHEN $4 THEN $3 ELSE finished_at END,
           final_error = COALESCE($5::jsonb, final_error)
       WHERE id = $1`,
    [runId, status, now, finalize, opts?.error ? JSON.stringify(opts.error) : null],
  );
  await notify(pool, { runId, kind: "run_status", status });
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
  msg: Omit<Message, "id" | "createdAt"> & { id?: string; runId: RunId },
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
      `INSERT INTO agent_messages (id, run_id, seq, role, content, usage)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING *`,
      [
        id,
        msg.runId,
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
           started_at = COALESCE($3, started_at, CASE WHEN $2 = 'running' THEN now() ELSE NULL END),
           finished_at = COALESCE($4, finished_at, CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE NULL END)
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

// --------------------------------------------------------------------
// LISTEN/NOTIFY
// --------------------------------------------------------------------

export type NotifyPayload =
  | { runId: string; kind: "run_created" }
  | { runId: string; kind: "run_status"; status: RunStatus }
  | { runId: string; kind: "message"; messageId: string }
  | { runId: string; kind: "tool_call"; toolCallId: string }
  | { runId: string; kind: "tool_result"; toolCallId: string };

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
    cursor: row.cursor ?? ZERO_CURSOR,
    totalCostUsd: Number(row.total_cost_usd ?? 0),
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
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
