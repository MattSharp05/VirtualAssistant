// One way to tell Matthew something: a `notice` event (the Desk shows it as a card) and, when
// asked, a Telegram message. Telegram is attached at startup when the bot exists.

import type { DndState, NoticeAction, NoticeLevel } from "@jarvis/shared";
import { bus as defaultBus, type EventBus } from "./events.js";

export interface Notice {
  title: string;
  body?: string;
  level?: NoticeLevel;
  /** Where to look (e.g. the session's link). */
  link?: string;
  /** Buttons on the Desk's card (Telegram shows the link instead). */
  actions?: NoticeAction[];
  /** Also send to Telegram. */
  telegram?: boolean;
}

export type TelegramSend = (text: string) => Promise<void>;

export class Notifier {
  private telegram?: TelegramSend;
  private dndState: DndState = { on: false };

  constructor(private readonly bus: EventBus = defaultBus) {}

  attachTelegram(send: TelegramSend | undefined): void {
    this.telegram = send;
  }

  /** Do Not Disturb: notices are still published (the Desk records them) but not sent to Telegram. */
  setDnd(on: boolean, until?: string): DndState {
    this.dndState = on ? { on: true, ...(until ? { until } : {}) } : { on: false };
    return this.dnd;
  }

  get dnd(): DndState {
    if (this.dndState.on && this.dndState.until && Date.parse(this.dndState.until) <= Date.now()) this.dndState = { on: false };
    return { ...this.dndState };
  }

  async notify(n: Notice): Promise<void> {
    const level = n.level ?? "info";
    this.bus.publish({ type: "notice", at: new Date().toISOString(), level, title: n.title, body: n.body, ...(n.link ? { link: n.link } : {}), ...(n.actions?.length ? { actions: n.actions } : {}) });
    if (n.telegram && this.telegram && !this.dnd.on) {
      const icon = level === "alert" ? "⛔" : level === "warn" ? "⚠️" : "ℹ️";
      const text = `${n.title.startsWith(icon) ? "" : `${icon} `}${n.title}${n.body ? `\n${n.body}` : ""}${n.link ? `\n${n.link}` : ""}`;
      await this.telegram(text).catch((err) => console.error("telegram notify:", err));
    }
  }
}

/** The process-wide notifier. */
export const notifier = new Notifier();
export const notify = (n: Notice) => notifier.notify(n);
