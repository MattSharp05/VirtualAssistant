import { features } from "../features/registry";
import { scenarios } from "./scenarios";

/** Windows to preview: every registered feature, plus the placeholder home and the overlay. */
export function previewWindows(): { id: string; title: string }[] {
  const fromRegistry = features.map((f) => ({ id: f.id, title: f.title }));
  const extra = [
    { id: "home", title: "Home (placeholder)" },
    { id: "overlay", title: "Overlay" },
  ].filter((w) => !fromRegistry.some((f) => f.id === w.id));
  return [...fromRegistry, ...extra];
}

export function DevIndex() {
  const windows = previewWindows();
  return (
    <main className="dev-index">
      <h1>JARVIS Desk · preview</h1>
      <p>Each link opens one window of the Desk UI, fed by a mock scenario.</p>
      {scenarios.map((s) => (
        <section key={s.name}>
          <h2>{s.name}</h2>
          <p>{s.description}</p>
          <ul>
            {windows.map((w) => (
              <li key={w.id}>
                <a
                  href={`index.html?scenario=${encodeURIComponent(s.name)}&window=${encodeURIComponent(w.id)}`}
                >
                  {w.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
