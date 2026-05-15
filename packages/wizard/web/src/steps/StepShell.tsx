/**
 * Shared layout + buttons for non-template wizard steps. Brutalist
 * theme: `.hr-section` for the step title, `.btn` / `.btn-primary` for
 * Back / Next.
 */
export function StepShell({
  title,
  description,
  children,
  onPrev,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  onPrev: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="space-y-5">
      <div>
        <div className="hr-section">
          <span>{`// ${title.toUpperCase()}`}</span>
        </div>
        {description && <p className="mt-3 text-sm text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onPrev} className="btn">
          ← Back
        </button>
        <button type="button" onClick={onNext} disabled={nextDisabled} className="btn btn-primary">
          {nextLabel ?? "Next →"}
        </button>
      </div>
    </div>
  );
}
