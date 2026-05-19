import { useCallback, useEffect, useMemo, useState } from "react";
import { DiagnosticsBanner } from "./components/DiagnosticsBanner.js";
import { ToastProvider } from "./components/Toaster.js";
import {
  DeploymentProvider,
  useDeployment,
  useDeploymentName,
  useHarnessVersionLabel,
} from "./deployment-context.js";
import { uiPath } from "./lib/mount.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { ConfigTab } from "./tabs/ConfigTab.js";
import { ConnectionsTab } from "./tabs/ConnectionsTab.js";
import { DocsTab } from "./tabs/DocsTab.js";
import { type GuideSectionId, GuideTab, isGuideSectionId } from "./tabs/GuideTab.js";
import { RunsTab } from "./tabs/RunsTab.js";
import { ScheduledTab } from "./tabs/ScheduledTab.js";
import { UsageTab } from "./tabs/UsageTab.js";
import { VitalsTab } from "./tabs/VitalsTab.js";

type TabId =
  | "chat"
  | "runs"
  | "agents"
  | "scheduled"
  | "config"
  | "connections"
  | "usage"
  | "vitals"
  | "guide"
  | "docs";

interface Route {
  tab: TabId;
  /**
   * Optional run id. On the runs tab it opens the run detail view. On the
   * chat tab the second URL segment is a `conversationId` instead — kept
   * here for backwards-compat with hash parsing; see `conversationId`.
   */
  runId: string | null;
  /** On the chat tab, the conversation to hydrate. */
  conversationId: string | null;
  /** Optional guide section id when `tab === "guide"`. */
  guideSection: GuideSectionId | null;
}

const NAV_SECTIONS: {
  label: string | null;
  items: { id: TabId; label: string; mark: string }[];
}[] = [
  {
    label: null,
    items: [
      { id: "chat", label: "Chat", mark: ">" },
      { id: "runs", label: "Runs", mark: "[]" },
      { id: "scheduled", label: "Cron", mark: "()" },
      { id: "agents", label: "Agents", mark: "{}" },
      { id: "usage", label: "Usage", mark: "%%" },
      { id: "vitals", label: "Vitals", mark: "~~" },
      { id: "config", label: "Config", mark: "##" },
      { id: "connections", label: "Connections", mark: "<>" },
    ],
  },
  {
    label: "Learn",
    items: [
      { id: "guide", label: "Guide", mark: "?" },
      { id: "docs", label: "Documentation", mark: "::" },
    ],
  },
];

const TAB_IDS = new Set<TabId>(
  NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.id)),
);

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [head, id] = raw.split("/");
  const tab: TabId = head && TAB_IDS.has(head as TabId) ? (head as TabId) : "chat";
  const runId = tab === "runs" && id ? decodeURIComponent(id) : null;
  const conversationId = tab === "chat" && id ? decodeURIComponent(id) : null;
  const guideSection = tab === "guide" && id && isGuideSectionId(id) ? id : null;
  return { tab, runId, conversationId, guideSection };
}

export function App() {
  return (
    <DeploymentProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </DeploymentProvider>
  );
}

function AppInner() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  const deployment = useDeployment();
  const deploymentName = useDeploymentName();
  const harnessVersion = useHarnessVersionLabel();
  const vitalsEnabled = deployment?.operatorFeatures?.vitals.enabled === true;
  const activeTab = route.tab === "vitals" && !vitalsEnabled ? "config" : route.tab;

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

  // Chat tab updates the URL whenever its underlying conversationId changes
  // (a fresh conversation gets created, or the user resets). Use
  // replaceState so we don't pollute browser history with one entry per
  // turn.
  const onChatConversationChange = useCallback(
    (conversationId: string | null) => {
      if (route.tab !== "chat") return;
      const target = conversationId ? `#/chat/${encodeURIComponent(conversationId)}` : `#/chat`;
      if (window.location.hash === target) return;
      window.history.replaceState(null, "", target);
      setRoute({ tab: "chat", runId: null, conversationId, guideSection: null });
    },
    [route.tab],
  );

  // Guide tab updates the URL when the user picks a section from the
  // sidebar. replaceState keeps the back button useful (one entry for
  // entering Guide, not one per section).
  const onGuideSectionChange = useCallback((section: GuideSectionId) => {
    const target = `#/guide/${section}`;
    if (window.location.hash === target) return;
    window.history.replaceState(null, "", target);
    setRoute({
      tab: "guide",
      runId: null,
      conversationId: null,
      guideSection: section,
    });
  }, []);

  return (
    <div className="min-h-full lg:flex">
      <aside className="border-b border-line bg-canvas lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-b-0">
        <div className="border-b border-line p-4">
          <div className="text-base font-bold uppercase leading-none tracking-widest">
            <div>Render</div>
            <div>Loops</div>
          </div>
          <div className="mt-3 text-[10px] uppercase tracking-wider text-muted">
            {deploymentName}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted">{harnessVersion}</div>
        </div>

        <nav className="flex flex-wrap gap-0 lg:block lg:flex-1 lg:overflow-y-auto">
          {NAV_SECTIONS.map((section, idx) => (
            <div key={section.label ?? "main"} className={idx > 0 ? "border-t border-line" : ""}>
              {section.label && (
                <div className="px-4 pt-4 pb-2 text-[10px] uppercase tracking-widest text-muted">
                  {section.label}
                </div>
              )}
              {section.items
                .filter((item) => item.id !== "vitals" || vitalsEnabled)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left text-xs uppercase tracking-[0.18em] transition ${
                      activeTab === item.id
                        ? "bg-accent text-canvas"
                        : "text-muted hover:bg-code-bg hover:text-ink"
                    }`}
                    onClick={() => navigate(item.id)}
                  >
                    <span className="w-6 font-mono text-[10px]">{item.mark}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-4 text-[10px] uppercase tracking-wider text-muted">
          <div>System</div>
          <div className="mt-2">gateway status: running</div>
          <form method="post" action={uiPath("/logout")} className="mt-4">
            <button type="submit" className="btn w-full">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main
        className={
          activeTab === "docs"
            ? "min-w-0 flex-1 lg:h-screen lg:overflow-hidden"
            : "min-w-0 flex-1 px-4 py-6 lg:max-h-screen lg:overflow-y-auto"
        }
      >
        {activeTab === "docs" ? (
          <DocsTab />
        ) : (
          <div className="mx-auto w-full max-w-6xl">
            <DiagnosticsBanner />
            {activeTab === "chat" && (
              <ChatTab
                conversationId={route.conversationId}
                onConversationChange={onChatConversationChange}
              />
            )}
            {activeTab === "runs" && (
              <RunsTab
                runId={route.runId}
                onSelectRun={(id) => navigate("runs", id)}
                onBackToList={() => navigate("runs")}
                onOpenInChat={(conversationId) => navigate("chat", conversationId)}
              />
            )}
            {activeTab === "agents" && <AgentsTab />}
            {activeTab === "scheduled" && <ScheduledTab />}
            {activeTab === "config" && <ConfigTab />}
            {activeTab === "connections" && <ConnectionsTab />}
            {activeTab === "usage" && <UsageTab />}
            {activeTab === "vitals" && <VitalsTab />}
            {activeTab === "guide" && (
              <GuideTab section={route.guideSection} onSectionChange={onGuideSectionChange} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
