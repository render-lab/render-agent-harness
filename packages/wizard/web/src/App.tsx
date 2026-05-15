import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { fetchGallery, postBundleScaffold, postScaffold, watchScaffoldJob } from "./lib/api.js";
import { DEFAULT_STATE, seedFromTemplate } from "./lib/state.js";
import type {
  Gallery,
  GalleryAgent,
  ScaffoldProgressEvent,
  ScaffoldResponse,
  WizardState,
} from "./lib/types.js";
import { Basics } from "./steps/Basics.js";
import { BundleReview } from "./steps/BundleReview.js";
import { Capabilities } from "./steps/Capabilities.js";
import { ModelStep } from "./steps/ModelStep.js";
import { Review } from "./steps/Review.js";
import { Runtimes } from "./steps/Runtimes.js";
import { Success } from "./steps/Success.js";
import { SystemPrompt } from "./steps/SystemPrompt.js";
import { Template } from "./steps/Template.js";
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
  "Template",
  "Basics",
  "System prompt",
  "Model",
  "Runtimes",
  "Operator UI",
  "Capabilities",
  "Review",
] as const;

export function App() {
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const goHome = useCallback(() => {
    setPhase({ kind: "ready", step: 0, state: DEFAULT_STATE });
  }, []);

  useEffect(() => {
    fetchGallery()
      .then((g) => {
        setGallery(g);
        setPhase({ kind: "ready", step: 0, state: DEFAULT_STATE });
      })
      .catch((err) => setGalleryError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (galleryError) {
    return <ErrorScreen message={`Could not load gallery: ${galleryError}`} onHome={goHome} />;
  }
  if (!gallery || phase.kind === "loading") {
    return <CenteredMessage onHome={goHome}>Loading…</CenteredMessage>;
  }

  if (phase.kind === "submitting") {
    return (
      <SubmittingScreen
        state={phase.state}
        jobId={phase.jobId}
        events={phase.events}
        onHome={goHome}
      />
    );
  }
  if (phase.kind === "error") {
    return (
      <ErrorScreen
        message={phase.message}
        onRetry={() => setPhase({ kind: "ready", step: 7, state: phase.state })}
        onHome={goHome}
      />
    );
  }
  if (phase.kind === "success") {
    return (
      <Shell currentStep={STEP_TITLES.length - 1} stepTitle="Success" onHome={goHome}>
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
      <Shell currentStep={0} totalSteps={2} stepTitle="Bundle review" onHome={goHome}>
        <BundleReview
          bundle={phase.bundle}
          onSubmit={submitBundle}
          onPrev={() => setPhase({ kind: "ready", step: 0, state: DEFAULT_STATE })}
        />
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
    <Shell currentStep={step} onHome={goHome}>
      {step === 0 && (
        <Template
          gallery={gallery}
          state={state}
          onPick={(t) => {
            // Sealed bundles short-circuit the per-agent steps — they
            // route to a dedicated review screen.
            if (t?.kind === "bundle") {
              setPhase({ kind: "bundle-review", bundle: t });
              return;
            }
            const seeded = t ? seedFromTemplate(t) : DEFAULT_STATE;
            setPhase({ kind: "ready", step: 1, state: seeded });
          }}
        />
      )}
      {step === 1 && <Basics state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />}
      {step === 2 && (
        <SystemPrompt state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />
      )}
      {step === 3 && (
        <ModelStep state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />
      )}
      {step === 4 && <Runtimes state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />}
      {step === 5 && <UiToggle state={state} onChange={setState} onNext={goNext} onPrev={goPrev} />}
      {step === 6 && (
        <Capabilities
          state={state}
          gallery={gallery}
          onChange={setState}
          onNext={goNext}
          onPrev={goPrev}
        />
      )}
      {step === 7 && <Review state={state} onSubmit={submit} onPrev={goPrev} />}
    </Shell>
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
  onHome,
  children,
}: {
  currentStep: number;
  totalSteps?: number;
  stepTitle?: string;
  onHome: () => void;
  children: React.ReactNode;
}) {
  const total = totalSteps ?? STEP_TITLES.length;
  const title = stepTitle ?? STEP_TITLES[currentStep] ?? "Wizard";
  return (
    <div className="min-h-screen">
      <WizardHeader currentStep={currentStep} total={total} title={title} onHome={onHome} />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-5 py-8 lg:grid-cols-[1fr_280px]">
        <section className="panel p-6">{children}</section>
        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
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
    </div>
  );
}

function WizardHeader({
  currentStep,
  total,
  title,
  onHome,
}: {
  currentStep: number;
  total: number;
  title: string;
  onHome: () => void;
}) {
  const navItems =
    total === STEP_TITLES.length
      ? STEP_TITLES.map((label) => ({ id: label, label }))
      : [
          { id: "template", label: "Template" },
          { id: "current", label: title },
        ];
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
        <button type="button" className="text-left" onClick={onHome} title="Return to wizard home">
          <div className="text-sm font-bold uppercase leading-none tracking-widest">
            <div>Render</div>
            <div>Harness Wizard</div>
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">
            managed repo scaffold
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
            <span>
              step {currentStep + 1}/{total}
            </span>
            <span>/</span>
            <span className="text-ink">{title}</span>
          </div>
          <button type="button" className="btn" onClick={onHome}>
            Home
          </button>
        </div>
      </div>
      <div className="border-t border-line px-5 py-2">
        <nav className="mx-auto flex max-w-6xl gap-2 overflow-x-auto pb-1">
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
    </header>
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
  onHome,
}: {
  state: WizardState;
  jobId: string | null;
  events: ScaffoldProgressEvent[];
  onHome: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, []);

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
    <div className="min-h-screen">
      <WizardHeader
        currentStep={STEP_TITLES.length - 1}
        total={STEP_TITLES.length}
        title="Creating repository"
        onHome={onHome}
      />
      <main className="flex min-h-[calc(100vh-7rem)] items-center justify-center px-6 py-10">
        <div className="panel flex max-h-[calc(100vh-10rem)] w-full max-w-2xl flex-col p-6">
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

          <ol className="mt-5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-2 text-xs">
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
      </main>
    </div>
  );
}

function CenteredMessage({ children, onHome }: { children: React.ReactNode; onHome: () => void }) {
  return (
    <div className="min-h-screen">
      <WizardHeader currentStep={0} total={STEP_TITLES.length} title="Loading" onHome={onHome} />
      <main className="flex min-h-[calc(100vh-7rem)] items-center justify-center text-muted">
        <span className="label">{children}</span>
      </main>
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
    <div className="min-h-screen">
      <WizardHeader currentStep={0} total={STEP_TITLES.length} title="Error" onHome={onHome} />
      <main className="flex min-h-[calc(100vh-7rem)] items-center justify-center px-6">
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
      </main>
    </div>
  );
}

export type { Gallery, WizardState } from "./lib/types.js";
