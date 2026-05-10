import { useCallback, useEffect, useMemo, useState } from "react";
import { DiagnosticsBanner } from "./components/DiagnosticsBanner.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { GuideTab, type GuideSectionId, isGuideSectionId } from "./tabs/GuideTab.js";
import { RunsTab } from "./tabs/RunsTab.js";
import { UsageTab } from "./tabs/UsageTab.js";

type TabId = "chat" | "runs" | "agents" | "usage" | "guide";

interface Route {
  tab: TabId;
  /**
   * Optional run id. On the runs tab it opens the run detail view; on the
   * chat tab it hydrates a specific (chat-shape) run instead of the
   * caller's most recent active session.
   */
  runId: string | null;
  /** Optional guide section id when `tab === "guide"`. */
  guideSection: GuideSectionId | null;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "chat", label: "CHAT" },
  { id: "runs", label: "RUNS" },
  { id: "agents", label: "AGENTS" },
  { id: "usage", label: "USAGE" },
  { id: "guide", label: "GUIDE" },
];

const TAB_IDS = new Set<TabId>(["chat", "runs", "agents", "usage", "guide"]);

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [head, id] = raw.split("/");
  const tab: TabId = head && TAB_IDS.has(head as TabId) ? (head as TabId) : "chat";
  const runId =
    (tab === "runs" || tab === "chat") && id ? decodeURIComponent(id) : null;
  const guideSection =
    tab === "guide" && id && isGuideSectionId(id) ? id : null;
  return { tab, runId, guideSection };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useMemo(
    () => (tab: TabId, sub?: string | null) => {
      const target = sub ? `#/${tab}/${encodeURIComponent(sub)}` : `#/${tab}`;
      if (window.location.hash !== target) {
        window.location.hash = target;
      } else {
        // Same hash already; just refresh the parsed state in case it
        // got out of sync.
        setRoute(parseHash());
      }
    },
    [],
  );

  // Chat tab updates the URL whenever its underlying runId changes (a new
  // session is started, or the user resets). Use replaceState so we don't
  // pollute browser history with one entry per turn.
  const onChatRunChange = useCallback((runId: string | null) => {
    if (route.tab !== "chat") return;
    const target = runId ? `#/chat/${encodeURIComponent(runId)}` : `#/chat`;
    if (window.location.hash === target) return;
    window.history.replaceState(null, "", target);
    setRoute({ tab: "chat", runId, guideSection: null });
  }, [route.tab]);

  // Guide tab updates the URL when the user picks a section from the
  // sidebar. replaceState keeps the back button useful (one entry for
  // entering Guide, not one per section).
  const onGuideSectionChange = useCallback((section: GuideSectionId) => {
    const target = `#/guide/${section}`;
    if (window.location.hash === target) return;
    window.history.replaceState(null, "", target);
    setRoute({ tab: "guide", runId: null, guideSection: section });
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <div className="text-xs uppercase tracking-widest">
              <span className="text-muted">render-harness</span>
              <span className="mx-2 text-muted">/</span>
              <span>operator</span>
            </div>
            <nav className="flex items-center gap-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`btn ${route.tab === t.id ? "btn-active" : ""}`}
                  onClick={() => navigate(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
          <form method="post" action="/ui/logout">
            <button type="submit" className="btn">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <DiagnosticsBanner />
        {route.tab === "chat" && (
          <ChatTab
            runId={route.runId}
            onActiveRunChange={onChatRunChange}
          />
        )}
        {route.tab === "runs" && (
          <RunsTab
            runId={route.runId}
            onSelectRun={(id) => navigate("runs", id)}
            onBackToList={() => navigate("runs")}
            onOpenInChat={(id) => navigate("chat", id)}
          />
        )}
        {route.tab === "agents" && <AgentsTab />}
        {route.tab === "usage" && <UsageTab />}
        {route.tab === "guide" && (
          <GuideTab section={route.guideSection} onSectionChange={onGuideSectionChange} />
        )}
      </main>
    </div>
  );
}
