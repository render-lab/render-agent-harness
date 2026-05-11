import { useEffect, useState } from "react";
import { fetchGallery, postScaffold } from "./lib/api.js";
import { DEFAULT_STATE, seedFromTemplate } from "./lib/state.js";
import type { Gallery, ScaffoldResponse, WizardState } from "./lib/types.js";
import { Basics } from "./steps/Basics.js";
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

function Shell({ currentStep, children }: { currentStep: number; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-6">
        <div className="hr-section">
          <span>// CREATE A RENDER AGENT</span>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="label">
            Step {currentStep + 1}/{STEP_TITLES.length} · {STEP_TITLES[currentStep]}
          </span>
          <span className="text-muted text-[11px]">render-harness wizard</span>
        </div>
      </header>
      <Progress current={currentStep} />
      <main className="panel mt-6 p-6">{children}</main>
    </div>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <div className="flex gap-1">
      {STEP_TITLES.map((title, i) => (
        <div
          key={title}
          className={`h-1 flex-1 ${i <= current ? "bg-accent" : "border border-line"}`}
        />
      ))}
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
        <h2 className="label text-err">// SOMETHING WENT WRONG</h2>
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
