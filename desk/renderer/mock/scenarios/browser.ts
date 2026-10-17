// The Browser window (JD-59), for the preview, e2e and snapshots: JARVIS booking a table on a
// restaurant's site. Idle on the booking page; acting (the ring around “Check availability” and its
// caption); and after Matthew took over, with JARVIS waiting. The page is the window's preview stand-in.
import type { BrowserState } from "@jarvis/shared";
import type { Scenario } from "../types";

const booking: BrowserState = {
  tabs: [
    {
      id: "tab-1",
      url: "https://reservas.example/taberna-da-rua",
      title: "Book a table · Taberna da Rua",
      active: true,
    },
    { id: "tab-2", url: "https://maps.example/lisbon/alfama", title: "Alfama, Lisbon · Maps", active: false },
  ],
  url: "https://reservas.example/taberna-da-rua",
  title: "Book a table · Taberna da Rua",
  canGoBack: true,
  canGoForward: false,
  loading: false,
  control: "jarvis",
  status: "Booking a table for 4 · Friday 23 October, 20:00",
};

const scenarios: Scenario[] = [
  {
    name: "browser-idle",
    description:
      "Browser: the booking page open in two tabs, JARVIS's task on the status line, Take over ready.",
    data: {},
    events: [],
    browser: booking,
  },
  {
    name: "browser-acting",
    description:
      "Browser: JARVIS about to click “Check availability”: the ring around the button and the “Clicking …” caption.",
    data: {},
    events: [
      { after: 100, event: { type: "browser.action", caption: "Typing ‘4’ into ‘Party size’", ref: 12 } },
      { after: 50, event: { type: "browser.action", caption: "Clicking ‘Check availability’", ref: 14 } },
    ],
    browser: booking,
  },
  {
    name: "browser-takeover",
    description: "Browser: Matthew has taken over; JARVIS waits and the button says Hand back.",
    data: {},
    events: [],
    browser: { ...booking, control: "matthew" },
  },
];

export default scenarios;
