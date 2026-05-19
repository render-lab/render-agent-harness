import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { BrowsePage } from "./BrowsePage.js";
import { Footer } from "./components/Footer.js";
import {
  type AuthMe,
  fetchGallery,
  fetchMe,
  postBundleScaffold,
  postLogout,
  postScaffold,
  watchScaffoldJob,
} from "./lib/api.js";
import { DEFAULT_STATE, seedFromTemplate } from "./lib/state.js";
import type {
  Gallery,
  GalleryAgent,
  ScaffoldProgressEvent,
  ScaffoldResponse,
  WizardState,
} from "./lib/types.js";
import { MyHarnessesPage } from "./MyHarnesses.js";
import { Basics } from "./steps/Basics.js";
import { BundleReview } from "./steps/BundleReview.js";
import { Capabilities } from "./steps/Capabilities.js";
import { ModelStep } from "./steps/ModelStep.js";
import { Review } from "./steps/Review.js";
import { Runtimes } from "./steps/Runtimes.js";
import { Success } from "./steps/Success.js";
import { SystemPrompt } from "./steps/SystemPrompt.js";
import { UiToggle } from "./steps/UiToggle.js";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; step: number; state: WizardState }
  | { kind: "bundle-review"; bundle: GalleryAgent }
  | {
      kind: "submitting";
      state: WizardState;
      jobId: string | null;
      events: ScaffoldProgressEvent[];
    }
  | { kind: "success"; state: WizardState; result: ScaffoldResponse }
  | { kind: "error"; state: WizardState; message: string };

const STEP_TITLES = [
  "Basics",
  "System prompt",
  "Model",
  "Runtimes",
  "Operator UI",
  "Capabilities",
  "Review",
] as const;

type PublicRoute = "browse" | "new" | "my";

const DOCS_URL = "https://render-agent-harness.onrender.com/";

function parseRoute(): PublicRoute {
  const path = window.location.pathname;
  if (path === "/new") return "new";
  if (path === "/my" || path.startsWith("/my/")) return "my";
  return "browse";
}

function initialNewPhase(gallery: Gallery): Phase {
  const templateSlug = new URLSearchParams(window.location.search).get("template");
  const template = templateSlug
    ? gallery.agents.find((agent) => agent.slug === templateSlug)
    : null;
  if (!template) return { kind: "ready", step: 0, state: DEFAULT_STATE };
  if (template.kind === "bundle") return { kind: "bundle-review", bundle: template };
  return { kind: "ready", step: 0, state: seedFromTemplate(template) };
}

export function App() {
  const [route, setRoute] = useState<PublicRoute>(() => parseRoute());
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    fetchMe()
      .then((res) => setMe(res))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/browse");
    }
  }, []);

  const navigate = useCallback((next: PublicRoute) => {
    const path = next === "new" ? "/new" : next === "my" ? "/my" : "/browse";
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  const goHome = useCallback(() => {
    setPhase({ kind: "ready", step: 0, state: DEFAULT_STATE });
  }, []);

  useEffect(() => {
    fetchGallery()
      .then((g) => {
        setGallery(g);
        setPhase(initialNewPhase(g));
      })
      .catch((err) => setGalleryError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (route === "browse") {
    return (
      <PublicShell route={route} onNavigate={navigate} me={me}>
        <BrowsePage />
      </PublicShell>
    );
  }

  if (route === "my") {
    return (
      <PublicShell route={route} onNavigate={navigate} me={me}>
        <MyHarnessesPage />
      </PublicShell>
    );
  }

  if (galleryError) {
    return (
      <PublicShell route={route} onNavigate={navigate} me={me}>
        <ErrorScreen message={`Could not load gallery: ${galleryError}`} onHome={goHome} />
      </PublicShell>
    );
  }
  if (!gallery || phase.kind === "loading") {
    return (
      <PublicShell route={route} onNavigate={navigate} me={me}>
        <CenteredMessage onHome={goHome}>Loading…</CenteredMessage>
      </PublicShell>
    );
  }

  if (phase.kind === "submitting") {
    return (
      <SubmittingScreen
        state={phase.state}
        jobId={phase.jobId}
        events={phase.events}
        me={me}
        route={route}
        onNavigate={navigate}
        onHome={goHome}
      />
    );
  }
  if (phase.kind === "error") {
    return (
      <PublicShell route={route} onNavigate={navigate} me={me}>
        <ErrorScreen
          message={phase.message}
          onRetry={() =>
            setPhase({ kind: "ready", step: STEP_TITLES.length - 1, state: phase.state })
          }
          onHome={goHome}
        />
      </PublicShell>
    );
  }
  if (phase.kind === "success") {
    return (
      <Shell
        currentStep={STEP_TITLES.length - 1}
        stepTitle="Success"
        me={me}
        route={route}
        onNavigate={navigate}
        withAside={false}
      >
        <Success state={phase.state} result={phase.result} />
      </Shell>
    );
  }
  if (phase.kind === "bundle-review") {
    const submitBundle = async (args: { agentName: string; description: string }) => {
      const fakeState: WizardState = {
        ...DEFAULT_STATE,
        templateSlug: phase.bundle.slug,
        agentName: args.agentName,
        description: args.description,
      };
      setPhase({ kind: "submitting", state: fakeState, jobId: null, events: [] });
      try {
        const { jobId } = await postBundleScaffold({
          bundleSlug: phase.bundle.slug,
          agentName: args.agentName,
          description: args.description,
          turnstileToken: "",
        });
        setPhase((current) =>
          current.kind === "submitting" && current.state === fakeState
            ? { ...current, jobId }
            : current,
        );
        const result = await watchScaffoldJob(jobId, (event) =>
          appendScaffoldEvent(fakeState, event, setPhase),
        );
        setPhase({ kind: "success", state: fakeState, result });
      } catch (err) {
        setPhase({
          kind: "error",
          state: fakeState,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
    return (
      <Shell
        currentStep={0}
        totalSteps={2}
        stepTitle="Bundle review"
        me={me}
        route={route}
        onNavigate={navigate}
      >
        <BundleReview bundle={phase.bundle} me={me} onSubmit={submitBundle} onPrev={goHome} />
      </Shell>
    );
  }

  const { step, state } = phase;
  const setState = (next: WizardState) => setPhase({ kind: "ready", step, state: next });
  const goNext = () =>
    setPhase({ kind: "ready", step: Math.min(step + 1, STEP_TITLES.length - 1), state });
  const goPrev = () => setPhase({ kind: "ready", step: Math.max(step - 1, 0), state });

  const submit = async () => {
    setPhase({ kind: "submitting", state, jobId: null, events: [] });
    try {
      const { jobId } = await postScaffold({ state, turnstileToken: "" });
      setPhase((current) =>
        current.kind === "submitting" && current.state === state ? { ...current, jobId } : current,
      );
      const result = await watchScaffoldJob(jobId, (event) =>
        appendScaffoldEvent(state, event, setPhase),
      );
      setPhase({ kind: "success", state, result });
    } catch (err) {
      setPhase({
        kind: "error",
        state,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Shell currentStep={step} me={me} route={route} onNavigate={navigate}>
      {step === 0 && <Basics state={state} onChange={setState} onNext={goNext} />}
      {step === 1 && (
        <SystemPrompt state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />
      )}
      {step === 2 && (
        <ModelStep state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />
      )}
      {step === 3 && <Runtimes state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />}
      {step === 4 && <UiToggle state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />}
      {step === 5 && (
        <Capabilities
          state={state}
          gallery={gallery}
          onChange={setState}
          onNext={goNext}
          onPrev={goPrev}
        />
      )}
      {step === 6 && <Review state={state} me={me} onSubmit={submit} onPrev={goPrev} />}
    </Shell>
  );
}

function TopNav({
  route,
  onNavigate,
  me,
  subtitle,
}: {
  route: PublicRoute;
  onNavigate: (route: PublicRoute) => void;
  me: AuthMe | null;
  subtitle?: string;
}) {
  const onLogout = async () => {
    await postLogout();
    window.location.reload();
  };
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
        <button
          type="button"
          className="text-left"
          onClick={() => onNavigate("browse")}
          title="Browse loops"
        >
          <div className="text-sm font-bold uppercase leading-none tracking-widest">
            <div>Render</div>
            <div>Loops</div>
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">
            {subtitle ?? "agent runtime"}
          </div>
        </button>
        <nav className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`btn ${route === "browse" ? "btn-active" : ""}`}
            onClick={() => onNavigate("browse")}
          >
            Browse
          </button>
          <button
            type="button"
            className={`btn ${route === "new" ? "btn-active" : ""}`}
            onClick={() => onNavigate("new")}
          >
            New
          </button>
          {me ? (
            <button
              type="button"
              className={`btn ${route === "my" ? "btn-active" : ""}`}
              onClick={() => onNavigate("my")}
            >
              My loops
            </button>
          ) : null}
          <a className="btn" href={DOCS_URL}>
            Docs
          </a>
          {me ? (
            <div className="btn flex items-center gap-2">
              {me.avatarUrl ? (
                <img
                  src={me.avatarUrl}
                  alt=""
                  width={18}
                  height={18}
                  className="rounded-full border border-line"
                />
              ) : null}
              <span className="text-muted">@{me.login}</span>
              <button
                type="button"
                className="border-l border-line pl-2 text-accent hover:underline"
                onClick={onLogout}
              >
                sign out
              </button>
            </div>
          ) : (
            <a className="btn" href="/api/auth/login?next=/my">
              Sign in with GitHub
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}

function PublicShell({
  route,
  onNavigate,
  me,
  children,
}: {
  route: PublicRoute;
  onNavigate: (route: PublicRoute) => void;
  me: AuthMe | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopNav route={route} onNavigate={onNavigate} me={me} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <Footer />
    </div>
  );
}

function appendScaffoldEvent(
  state: WizardState,
  event: ScaffoldProgressEvent,
  setPhase: Dispatch<SetStateAction<Phase>>,
): void {
  setPhase((current) => {
    if (current.kind !== "submitting" || current.state !== state) return current;
    return { ...current, events: [...current.events, event] };
  });
}

function Shell({
  currentStep,
  totalSteps,
  stepTitle,
  me,
  route,
  onNavigate,
  withAside = true,
  children,
}: {
  currentStep: number;
  totalSteps?: number;
  stepTitle?: string;
  me: AuthMe | null;
  route: PublicRoute;
  onNavigate: (route: PublicRoute) => void;
  withAside?: boolean;
  children: React.ReactNode;
}) {
  const total = totalSteps ?? STEP_TITLES.length;
  const title = stepTitle ?? STEP_TITLES[currentStep] ?? "Wizard";
  return (
    <div className="flex min-h-screen flex-col">
      <TopNav route={route} onNavigate={onNavigate} me={me} />
      <StepIndicator currentStep={currentStep} total={total} title={title} />
      {withAside ? (
        <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 px-5 py-8 lg:grid-cols-[1fr_280px]">
          <section className="panel p-6">{children}</section>
          <aside className="space-y-4 lg:sticky lg:top-40 lg:self-start">
            <div className="panel p-4">
              <div className="label mb-3">progress</div>
              <Progress current={currentStep} total={total} />
              <div className="mt-3 text-xs text-muted">
                Choose a template, tune the runtime, then create a managed repo and deploy.
              </div>
            </div>
            <div className="panel p-4 text-xs">
              <div className="label mb-2">output</div>
              <div>GitHub repo</div>
              <div>render-harness.yaml</div>
              <div>Deploy to Render link</div>
            </div>
          </aside>
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      )}
      <Footer />
    </div>
  );
}

function StepIndicator({
  currentStep,
  total,
  title,
}: {
  currentStep: number;
  total: number;
  title: string;
}) {
  const navItems =
    total === STEP_TITLES.length
      ? STEP_TITLES.map((label) => ({ id: label, label }))
      : [
          { id: "template", label: "Template" },
          { id: "current", label: title },
        ];
  return (
    <div className="sticky top-[64px] z-10 border-b border-line bg-canvas/95 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl gap-2 overflow-x-auto px-5 py-2">
        {navItems.map((item, idx) => {
          const isActive = idx === currentStep;
          const isDone = idx < currentStep;
          return (
            <div
              key={item.id}
              className={`flex shrink-0 items-center gap-2 border px-3 py-1.5 text-[10px] uppercase tracking-wider ${
                isActive
                  ? "border-accent bg-accent text-canvas"
                  : isDone
                    ? "border-line bg-surface text-ink"
                    : "border-line bg-canvas text-muted"
              }`}
            >
              <span className="font-mono">{String(idx + 1).padStart(2, "0")}</span>
              <span>{item.label}</span>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: total }, (_, i) => ({ id: `progress-${i}`, active: i <= current })).map(
        (segment) => (
          <div
            key={segment.id}
            className={`h-1 flex-1 ${segment.active ? "bg-accent" : "bg-surface-hover"}`}
          />
        ),
      )}
    </div>
  );
}

function SubmittingScreen({
  state,
  jobId,
  events,
  me,
  route,
  onNavigate,
  onHome: _onHome,
}: {
  state: WizardState;
  jobId: string | null;
  events: ScaffoldProgressEvent[];
  me: AuthMe | null;
  route: PublicRoute;
  onNavigate: (route: PublicRoute) => void;
  onHome: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const eventListRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const list = eventListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  });

  const displayEvents =
    events.length > 0
      ? events
      : [
          {
            type: "progress" as const,
            phase: "building_file_map" as const,
            message: "Starting scaffold job",
            at: new Date().toISOString(),
          },
        ];
  const latestFileProgress = [...displayEvents]
    .reverse()
    .find(
      (event) =>
        event.type === "progress" &&
        event.phase === "writing_files" &&
        typeof event.index === "number" &&
        typeof event.total === "number",
    ) as Extract<ScaffoldProgressEvent, { type: "progress" }> | undefined;
  const doneEvent = displayEvents.find((event) => event.type === "done");
  const progressPercent = doneEvent
    ? 100
    : latestFileProgress?.total
      ? Math.round(((latestFileProgress.index ?? 0) / latestFileProgress.total) * 100)
      : Math.min(95, Math.round((displayEvents.length / 7) * 100));

  return (
    <Shell
      currentStep={STEP_TITLES.length - 1}
      stepTitle="Creating repository"
      me={me}
      route={route}
      onNavigate={onNavigate}
      withAside={false}
    >
      <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center">
        <div className="panel flex w-full max-w-2xl flex-col p-6">
          <div className="hr-section">
            <span>{"// CREATING REPOSITORY"}</span>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border border-line p-3">
            <div>
              <div className="text-sm font-bold">{state.agentName}</div>
              <div className="mt-1 text-xs text-muted">
                {jobId ? `Job ${jobId.slice(0, 8)} is running.` : "Starting job…"}
              </div>
            </div>
            <div className="font-mono text-xs text-muted">{elapsed}s elapsed</div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>progress</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="h-2 border border-line bg-canvas">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <ol
            ref={eventListRef}
            className="mt-5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-2 text-xs"
          >
            {displayEvents.map((event) => {
              const active =
                event === displayEvents[displayEvents.length - 1] && event.type === "progress";
              const done =
                event !== displayEvents[displayEvents.length - 1] || event.type === "done";
              return (
                <li
                  key={`${event.at}-${event.type}-${event.phase}`}
                  className={`flex items-center justify-between border border-line p-3 ${
                    active ? "bg-surface-hover text-ink" : "text-muted"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={active ? "text-accent" : ""}>
                      {event.type === "error" ? "!" : done ? "✓" : active ? "▊" : "·"}
                    </span>
                    <span>
                      {event.message}
                      {event.type === "progress" && event.total ? (
                        <span className="ml-2 text-muted">
                          {event.index ?? 0}/{event.total}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {active && <span className="cli-dots" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>

          <p className="mt-5 text-xs text-muted">
            Keep this tab open. If GitHub rejects the request, the wizard returns an actionable
            error instead of leaving this screen.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function CenteredMessage({
  children,
  onHome: _onHome,
}: {
  children: React.ReactNode;
  onHome: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center text-muted">
      <span className="label">{children}</span>
    </div>
  );
}

function ErrorScreen({
  message,
  onRetry,
  onHome,
}: {
  message: string;
  onRetry?: () => void;
  onHome: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center px-6">
      <div className="panel max-w-md border-err p-6">
        <h2 className="label text-err">{"// SOMETHING WENT WRONG"}</h2>
        <p className="mt-3 text-sm">{message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {onRetry && (
            <button type="button" onClick={onRetry} className="btn btn-danger">
              Back to review
            </button>
          )}
          <button type="button" onClick={onHome} className="btn">
            Wizard home
          </button>
        </div>
      </div>
    </div>
  );
}

export type { Gallery, WizardState } from "./lib/types.js";
