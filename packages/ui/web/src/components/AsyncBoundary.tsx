import type { ReactNode } from "react";

interface AsyncBoundaryProps {
  loading: boolean;
  error: Error | null;
  children: ReactNode;
  empty?: { when: boolean; message: string };
}

/**
 * Cheap stand-in for Suspense + ErrorBoundary that's enough for a
 * brutalist admin panel: a hairline panel for empty/loading states, an
 * outlined block with red border for errors.
 */
export function AsyncBoundary({ loading, error, empty, children }: AsyncBoundaryProps) {
  if (error) {
    return (
      <div className="border border-err p-4 text-xs text-err">
        <div className="label !text-err">ERROR</div>
        <div className="mt-1 break-all">{error.message}</div>
      </div>
    );
  }
  if (loading) {
    return <Placeholder>loading</Placeholder>;
  }
  if (empty?.when) {
    return <Placeholder>{empty.message}</Placeholder>;
  }
  return <>{children}</>;
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="panel p-6 text-center text-muted text-xs">
      {children}
      <span className="blink ml-1 text-accent" aria-hidden="true">
        ▊
      </span>
    </div>
  );
}
