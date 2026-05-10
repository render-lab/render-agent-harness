/**
 * ASCII-style section header. Renders as
 *
 *     // LABEL ─────────────────────────────────────────────
 *
 * The horizontal line is a flexed border-top so it always extends to
 * fill the available width, no matter the container size.
 */
export function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="hr-section">
      <span>// {title}</span>
    </h2>
  );
}
