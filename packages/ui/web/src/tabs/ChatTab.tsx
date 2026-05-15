import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useState } from "react";
import { type AgentSummary, ApiError, listAgents } from "../api.js";
import { useConversationSession } from "../chat/runtime.js";
import { AsyncBoundary } from "../components/AsyncBoundary.js";
import { Markdown } from "../components/Markdown.js";

interface ChatTabProps {
  /** When set, hydrate this specific conversation; otherwise start blank. */
  conversationId: string | null;
  /** Called whenever the active conversationId changes (so the parent can update the URL). */
  onConversationChange: (conversationId: string | null) => void;
}

/**
 * Top-level Chat tab. Lists the available agents, lets the operator pick
 * one, and renders an assistant-ui Thread bound to a conversation via
 * `useConversationSession`. The first user message creates the
 * conversation up front; subsequent turns enqueue new runs against it.
 */
export function ChatTab({ conversationId, onConversationChange }: ChatTabProps) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingAgents(true);
    listAgents()
      .then((res) => {
        if (cancelled) return;
        setAgents(res.agents);
        if (res.agents[0]) {
          setSelectedAgent((prev) => prev ?? res.agents[0]?.name ?? null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setAgentError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AsyncBoundary
      loading={loadingAgents}
      error={agentError}
      empty={{
        when: agents.length === 0,
        message: "// no agents loaded — pass via serveWeb({ agent }) or serveWeb({ agents })",
      }}
    >
      <ChatBody
        agents={agents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        conversationId={conversationId}
        onConversationChange={onConversationChange}
      />
    </AsyncBoundary>
  );
}

interface ChatBodyProps {
  agents: AgentSummary[];
  selectedAgent: string | null;
  onSelectAgent: (name: string) => void;
  conversationId: string | null;
  onConversationChange: (conversationId: string | null) => void;
}

function ChatBody({
  agents,
  selectedAgent,
  onSelectAgent,
  conversationId,
  onConversationChange,
}: ChatBodyProps) {
  const session = useConversationSession({
    agentName: selectedAgent,
    conversationId,
    onConversationIdChange: onConversationChange,
  });

  const onNewChat = useCallback(() => {
    session.reset();
    onConversationChange(null);
  }, [session, onConversationChange]);

  const activeAgent = agents.find((a) => a.name === selectedAgent) ?? null;

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">
      <ChatToolbar
        agents={agents}
        selectedAgent={selectedAgent}
        onSelectAgent={onSelectAgent}
        conversationId={session.conversationId}
        status={session.status}
        onNewChat={onNewChat}
      />

      {session.error && (
        <div className="border border-err p-2 text-xs text-err">
          <span className="label text-err!">error:</span> {session.error.message}
        </div>
      )}

      <AssistantRuntimeProvider runtime={session.runtime}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport autoScroll className="flex-1 overflow-y-auto py-4">
            <ThreadPrimitive.Empty>
              <EmptyState agent={activeAgent} hydrating={session.hydrating} />
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage: UserBubble,
                AssistantMessage: AssistantBubble,
                SystemMessage: SystemBubble,
              }}
            />
          </ThreadPrimitive.Viewport>

          <Composer />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

// --------------------------------------------------------------------
// Toolbar
// --------------------------------------------------------------------

interface ChatToolbarProps {
  agents: AgentSummary[];
  selectedAgent: string | null;
  onSelectAgent: (name: string) => void;
  conversationId: string | null;
  status: string | null;
  onNewChat: () => void;
}

function ChatToolbar({
  agents,
  selectedAgent,
  onSelectAgent,
  conversationId,
  status,
  onNewChat,
}: ChatToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="label">agent:</span>
      {agents.length === 1 ? (
        <span>
          {agents[0]?.name} <span className="text-muted">v{agents[0]?.version}</span>
        </span>
      ) : (
        <select
          value={selectedAgent ?? ""}
          onChange={(e) => onSelectAgent(e.target.value)}
          className="px-1 py-0.5"
        >
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name} v{a.version}
            </option>
          ))}
        </select>
      )}

      <span className="label ml-3">conversation:</span>
      {conversationId ? (
        <span className="font-mono">{conversationId.slice(0, 16)}…</span>
      ) : (
        <span className="text-muted">{"// new chat"}</span>
      )}

      {status && (
        <>
          <span className="label ml-3">status:</span>
          <span className={statusBadgeClass(status)}>{status}</span>
        </>
      )}

      <button
        type="button"
        onClick={onNewChat}
        className="btn ml-auto"
        disabled={!conversationId}
        title="Start a new conversation (the previous one stays in the Runs tab)."
      >
        new chat
      </button>
    </div>
  );
}

function statusBadgeClass(status: string): string {
  if (status === "running" || status === "pending") return "badge badge-fill";
  if (status === "paused") return "badge badge-warn";
  if (status === "failed" || status === "cancelled") return "badge badge-err";
  return "badge";
}

// --------------------------------------------------------------------
// Empty state and message renderers
// --------------------------------------------------------------------

function EmptyState({ agent, hydrating }: { agent: AgentSummary | null; hydrating: boolean }) {
  if (hydrating) {
    return (
      <div className="text-center text-xs text-muted">
        loading session
        <span className="blink ml-1 text-accent" aria-hidden="true">
          ▊
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs text-muted">
      <div>
        <span className="label">{"// chat"}</span>
      </div>
      {agent ? (
        <div>
          ready · {agent.name} v{agent.version}
          <span className="blink ml-1 text-accent" aria-hidden="true">
            ▊
          </span>
        </div>
      ) : (
        <div>{"// pick an agent above to start chatting"}</div>
      )}
    </div>
  );
}

function UserBubble() {
  return (
    <div className="mb-5 text-sm last:mb-0">
      <div className="label mb-1.5">you</div>
      <div className="border-l-2 border-line pl-3">
        <MessagePrimitive.Parts components={{ Text: PlainText }} />
      </div>
    </div>
  );
}

function AssistantBubble() {
  return (
    <div className="mb-5 text-sm last:mb-0">
      <div className="label text-accent! mb-1.5">agent</div>
      <div className="border-l-2 border-accent pl-3">
        <AssistantContent />
      </div>
    </div>
  );
}

function AssistantContent() {
  return (
    <MessagePrimitive.Parts
      components={{
        Text: PlainText,
        Reasoning: ReasoningBlock,
        tools: { Fallback: ToolCallBlock },
      }}
    />
  );
}

function SystemBubble() {
  return (
    <div className="mb-5 text-xs last:mb-0">
      <div className="label mb-1.5">tool</div>
      <div className="border-l-2 border-muted pl-3">
        <details>
          <summary className="label cursor-pointer text-muted">raw result</summary>
          <div className="mt-2 text-muted">
            <MessagePrimitive.Parts components={{ Text: PlainText }} />
          </div>
        </details>
      </div>
    </div>
  );
}

function PlainText(props: TextMessagePartProps) {
  if (props.text === "thinking") return <ThinkingText />;
  return <Markdown text={props.text} />;
}

function ThinkingText() {
  return (
    <span className="text-muted">
      thinking
      <span className="cli-dots" aria-hidden="true" />
      <span className="sr-only">...</span>
    </span>
  );
}

function ReasoningBlock(props: ReasoningMessagePartProps) {
  return (
    <details className="my-1 border border-line p-2 text-xs">
      <summary className="cursor-pointer text-muted">thinking</summary>
      <pre className="mt-2 whitespace-pre-wrap text-[11px]">{props.text}</pre>
    </details>
  );
}

function ToolCallBlock(props: ToolCallMessagePartProps) {
  const argsText =
    typeof props.argsText === "string" ? props.argsText : safeJsonStringify(props.args ?? {});
  return (
    <div className="my-1 border border-line p-2 text-xs">
      <div className="label text-accent!">tool · {props.toolName}</div>
      <details className="mt-1">
        <summary className="label cursor-pointer text-muted">raw input</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">
          {argsText}
        </pre>
      </details>
      {props.result !== undefined && (
        <details className="mt-2 border-t border-line pt-2">
          <summary className="label cursor-pointer text-muted">raw result</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">
            {typeof props.result === "string" ? props.result : safeJsonStringify(props.result)}
          </pre>
        </details>
      )}
    </div>
  );
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// --------------------------------------------------------------------
// Composer
// --------------------------------------------------------------------

function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-center gap-3 border-t border-line py-3 pr-3 pl-0">
      <span aria-hidden="true" className="flex items-center text-accent leading-none">
        <span>$</span>
      </span>
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        maxRows={8}
        placeholder="ask the agent…"
        className="min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm leading-none focus:outline-none"
        submitMode="enter"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <button type="submit" className="btn btn-primary">
            send
          </button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <CancelRunButton />
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}

function CancelRunButton() {
  const runtime = useThreadRuntime();
  return (
    <button type="button" className="btn btn-danger" onClick={() => runtime.cancelRun()}>
      stop
    </button>
  );
}
