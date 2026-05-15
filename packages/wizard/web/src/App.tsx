import { useEffect, useState } from "react";
import { fetchGallery, postBundleScaffold, postScaffold } from "./lib/api.js";
import { DEFAULT_STATE, seedFromTemplate } from "./lib/state.js";
import type { Gallery, GalleryAgent, ScaffoldResponse, WizardState } from "./lib/types.js";
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
  | { kind: "submitting"; state: WizardState }
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

  useEffect(() => {
    fetchGallery()
      .then((g) => {
        setGallery(g);
        setPhase({ kind: "ready", step: 0, state: DEFAULT_STATE });
      })
      .catch((err) => setGalleryError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (galleryError) {
    return <ErrorScreen message={`Could not load gallery: ${galleryError}`} />;
  }
  if (!gallery || phase.kind === "loading") {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  if (phase.kind === "submitting") {
    return <CenteredMessage>Creating repository…</CenteredMessage>;
  }
  if (phase.kind === "error") {
    return (
      <ErrorScreen
        message={phase.message}
        onRetry={() => setPhase({ kind: "ready", step: 7, state: phase.state })}
      />
    );
  }
  if (phase.kind === "success") {
    return <Success state={phase.state} result={phase.result} />;
  }
  if (phase.kind === "bundle-review") {
    const submitBundle = async (args: { agentName: string; description: string }) => {
      const fakeState: WizardState = {
        ...DEFAULT_STATE,
        templateSlug: phase.bundle.slug,
        agentName: args.agentName,
        description: args.description,
      };
      setPhase({ kind: "submitting", state: fakeState });
      try {
        const result = await postBundleScaffold({
          bundleSlug: phase.bundle.slug,
          agentName: args.agentName,
          description: args.description,
          turnstileToken: "",
        });
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
      <Shell currentStep={0} totalSteps={2} stepTitle="Bundle review">
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
    setPhase({ kind: "submitting", state });
    try {
      const result = await postScaffold({ state, turnstileToken: "" });
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
    <Shell currentStep={step}>
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

function Shell({
  currentStep,
  totalSteps,
  stepTitle,
  children,
}: {
  currentStep: number;
  totalSteps?: number;
  stepTitle?: string;
  children: React.ReactNode;
}) {
  const total = totalSteps ?? STEP_TITLES.length;
  const title = stepTitle ?? STEP_TITLES[currentStep];
  const navItems =
    total === STEP_TITLES.length
      ? STEP_TITLES.map((label) => ({ id: label, label }))
      : [
          { id: "template", label: "Template" },
          { id: "bundle-review", label: title },
        ];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div>
            <div className="text-sm font-bold uppercase leading-none tracking-widest">
              <div>Render</div>
              <div>Harness Wizard</div>
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">
              managed repo scaffold
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
            <span>
              step {currentStep + 1}/{total}
            </span>
            <span>/</span>
            <span className="text-ink">{title}</span>
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

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted">
      <span className="label">{children}</span>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="panel max-w-md border-err p-6">
        <h2 className="label text-err">{"// SOMETHING WENT WRONG"}</h2>
        <p className="mt-3 text-sm">{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn btn-danger mt-4">
            Back to review
          </button>
        )}
      </div>
    </div>
  );
}

export type { Gallery, WizardState } from "./lib/types.js";
