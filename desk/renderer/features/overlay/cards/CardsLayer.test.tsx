import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import { BridgeProvider, chooseBridge } from "../../../app/bridge";
import { HAND_FLICK } from "../../../app/handTargets";
import { createMockBridge, type MockBridge } from "../../../mock/bridge";
import type { Scenario } from "../../../mock/types";
import { Overlay } from "../Overlay";
import { Markdown } from "../../../app/markdown";
import { AUTO_DISMISS_MS } from "./model";
import { DND_RECHECK_MS } from "./useCards";
import { CAPTION_HOLD_MS } from "./useVoiceReply";

function renderOn(scenario: string | Scenario) {
  const choice =
    typeof scenario === "string"
      ? chooseBridge(`?scenario=${scenario}`, undefined)
      : { bridge: createMockBridge(scenario), scenario: scenario.name };
  render(
    <BridgeProvider value={choice}>
      <Overlay />
    </BridgeProvider>,
  );
  return choice.bridge as MockBridge;
}

const settle = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const stack = () => within(screen.getByRole("region", { name: "Cards from JARVIS" }));
const scenario = (events: Scenario["events"], dnd = false): Scenario => ({
  name: "t",
  description: "",
  data: { "/mood": { mood: "green", reason: "", dnd: { on: dnd } } },
  events,
});

describe("cards beside the orb", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cards: agenda, session alert and timer, newest on top; Pop out opens Today", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const bridge = renderOn("cards");
    await settle(1000);
    const cards = stack().getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Timer: Tea",
      "⛔ mk is blocked",
      "Today",
    ]);
    expect(cards[1]!.dataset.level).toBe("alert");
    expect(stack().getByRole("timer").textContent).toMatch(/^4:1\d$/);
    fireEvent.click(stack().getByRole("button", { name: "Pop out Today" }));
    expect(bridge.opened).toEqual(["today"]);
    expect(stack().queryByRole("article", { name: "Today" })).toBeNull();
  });

  it("cards can be picked up by camera hands, and a flick throws one away (JD-47)", async () => {
    vi.useFakeTimers();
    renderOn("cards");
    await settle(1000);
    const today = stack().getByRole("article", { name: "Today" });
    expect(today.hasAttribute("data-hand-grab")).toBe(true);
    act(() => void today.dispatchEvent(new CustomEvent(HAND_FLICK, { bubbles: true })));
    expect(stack().queryByRole("article", { name: "Today" })).toBeNull();
    expect(stack().getAllByRole("article")).toHaveLength(2);
  });

  it("a browser task's question card: Approve / Change / Stop, Approve answering over the Desk API (JD-60)", async () => {
    vi.useFakeTimers();
    const bridge = renderOn("browser-task-normal");
    await settle(1000);
    const card = stack().getByRole("article", { name: "JARVIS needs your OK" });
    expect(card.textContent).toContain("Book Taberna da Rua for 2 on Fri 23 Oct at 20:00?");
    expect(
      within(card)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Approve", "Change", "Stop"]);
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await settle(10);
    expect(bridge.requests.at(-1)).toEqual({
      path: "/browser/tasks/task-taberna/answer",
      body: { questionId: "q-book", answer: "approve" },
    });
    expect(stack().queryByRole("article", { name: "JARVIS needs your OK" })).toBeNull();
  });

  it("a notice's action opens its window with params; Later and Dismiss just remove the card", async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const bridge = renderOn("cards");
    await settle(1000);
    fireEvent.click(stack().getByRole("button", { name: "Open session" }));
    expect(bridge.opened).toEqual(["sessions"]);
    expect(new URL(String(open.mock.calls[0]![0])).searchParams.get("id")).toBe("mk");
    fireEvent.click(stack().getByRole("button", { name: "Dismiss timer Tea" }));
    expect(stack().getAllByRole("article")).toHaveLength(1);
  });

  it("dismisses itself after a minute, unless the pointer is on it", async () => {
    vi.useFakeTimers();
    const card = (id: string): DeskEvent => ({
      type: "card.show",
      card: { id, createdAt: "", title: id, body: "", kind: "text" },
    });
    const bridge = renderOn(
      scenario([
        { after: 10, event: card("a") },
        { after: 10, event: card("b") },
      ]),
    );
    await settle(100);
    fireEvent.mouseEnter(stack().getByRole("article", { name: "a" }));
    expect(bridge.interactive).toBe(true);
    await settle(AUTO_DISMISS_MS);
    expect(
      stack()
        .getAllByRole("article")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["a"]);
    fireEvent.mouseLeave(stack().getByRole("article", { name: "a" }));
    await settle(AUTO_DISMISS_MS);
    expect(stack().queryAllByRole("article")).toHaveLength(0);
    // The card's hit region went with it: clicks pass through again.
    expect(bridge.interactive).toBe(false);
  });

  it("Do Not Disturb: notices become a badge on the orb; asked-for cards still show; the badge shows them", async () => {
    vi.useFakeTimers();
    renderOn("cards-dnd");
    await settle(1000);
    expect(
      stack()
        .getAllByRole("article")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Flights to Lisbon"]);
    const badge = screen.getByRole("button", { name: /2 notifications held by Do Not Disturb/ });
    expect(badge.textContent).toBe("2");
    fireEvent.click(badge);
    expect(stack().getAllByRole("article")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /held by Do Not Disturb/ })).toBeNull();
  });

  it("the Desk's own DND setting wins, and held notices come out once it's off", async () => {
    vi.useFakeTimers();
    const notice: DeskEvent = { type: "notice", at: "", level: "info", title: "batch done" };
    const bridge = renderOn(scenario([{ after: 100, event: notice }], false));
    await bridge.settings.set("dnd", true);
    await settle(200);
    expect(screen.getByRole("button", { name: /1 notification held/ })).toBeTruthy();
    await bridge.settings.set("dnd", false);
    await settle(DND_RECHECK_MS);
    expect(stack().getByRole("article", { name: "batch done" })).toBeTruthy();
  });

  it("voice replies: You said, then the spoken words, gone a while after the reply", async () => {
    vi.useFakeTimers();
    const bridge = renderOn("cards-voice");
    await settle(400);
    expect(screen.getByRole("complementary", { name: "You said" }).textContent).toContain("what's on today?");
    await settle(5000);
    expect(screen.getByRole("complementary", { name: "JARVIS (spoken)" }).textContent).toContain(
      "Three things today.",
    );
    // A typed turn doesn't get the voice caption.
    void bridge.chat("hello", "desk-typed");
    await settle(2000);
    expect(screen.getByRole("complementary", { name: "JARVIS (spoken)" }).textContent).not.toContain("hello");
    void bridge.chat("and tomorrow?", "desk-voice");
    await settle(100);
    expect(screen.getByRole("complementary", { name: "You said" }).textContent).toContain("and tomorrow?");
    await settle(3000);
    expect(screen.getByRole("complementary", { name: "JARVIS (spoken)" }).textContent).toContain("You said");
    await settle(CAPTION_HOLD_MS);
    expect(screen.queryByRole("complementary", { name: "You said" })).toBeNull();
  });
});

describe("card markdown", () => {
  afterEach(cleanup);

  it("renders paragraphs, bullets, bold, italic, code and safe links only", () => {
    const { container } = render(
      <Markdown
        text={"Hello **there** and *you*\n\n- one `x`\n- [site](https://a.b)\n\n[bad](javascript:alert(1))"}
      />,
    );
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("there");
    expect(container.querySelector("em")?.textContent).toBe("you");
    expect(container.querySelector("code")?.textContent).toBe("x");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://a.b");
    expect(container.textContent).toContain("bad");
  });
});
