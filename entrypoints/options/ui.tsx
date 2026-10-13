/**
 * Shared layout atoms for the options page sections.
 *
 * Kept in their own module so the profile editor and the settings panel use
 * the exact same markup/classes (no duplicated JSX, no drift).
 */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <div className="row-control">{children}</div>
    </div>
  );
}
