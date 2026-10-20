// Automatic updates (JD-74): an update downloaded in the background and ready to install, the card
// after JARVIS updated itself, and Settings with Install updates automatically off. Open the first two
// with ?window=overlay.
import type { Scenario } from "../types";
import settings from "./settings";

const at = "2026-10-20T09:00:00Z";
const notes = "https://github.com/MattSharp05/VirtualAssistant/releases/tag/desk-v1.3.0";
const paired = (settings as Scenario[]).find((s) => s.name === "settings")!;

const scenarios: Scenario[] = [
  {
    name: "update-ready",
    description: "JARVIS Desk 1.3.0 downloaded in the background: Restart now / Later beside the orb.",
    data: {},
    events: [
      {
        after: 200,
        event: {
          type: "notice",
          at,
          level: "info",
          title: "JARVIS Desk 1.3.0 is ready",
          body: "Restart now to update or it installs itself when you quit. JARVIS reopens on the new version in a few seconds.",
          actions: [{ label: "Restart now", url: `${notes}#jarvis-desk-restart` }, { label: "Later" }],
        },
      },
    ],
  },
  {
    name: "update-installed",
    description: "The first launch after an automatic update: Updated to 1.3.0, with the release notes.",
    data: {},
    events: [
      {
        after: 200,
        event: {
          type: "card.show",
          card: {
            id: "desk-update",
            createdAt: at,
            title: "Updated to 1.3.0",
            body: "JARVIS Desk installed **1.3.0** by itself (you had 1.2.9).",
            kind: "text",
            link: { label: "Release notes", url: notes },
          },
        },
      },
    ],
  },
  {
    ...paired,
    name: "settings-auto-update-off",
    description: "Settings with Install updates automatically off: updates wait for Restart now.",
    settings: { ...paired.settings, autoInstallUpdates: false },
  },
];

export default scenarios;
