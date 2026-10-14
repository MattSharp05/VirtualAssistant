// One way to tell Matthew something: a `notice` event (the Desk shows it as a card) and, when
// asked, a Telegram message. Telegram is attached at startup when the bot exists.

import type { NoticeLevel } from "@jarvis/shared";
import { bus as defaultBus, type EventBus } from "./events.js";

export interface Notice {
  title: string;
  body?: string;
  level?: NoticeLevel;
  /** Also send to Telegram. */
  telegram?: boolean;
}

export type TelegramSend = (text: string) => Promise<void>;

export class Notifier {
  private telegram?: TelegramSend;

  constructor(private readonly bus: EventBus = defaultBus) {}

  attachTelegram(send: TelegramSend | undefined): void {
    this.telegram = send;
  }

  async notify(n: Notice): Promise<void> {
    const level = n.level ?? "info";
    this.bus.publish({ type: "notice", at: new Date().toISOString(), level, title: n.title, body: n.body });
    if (n.telegram && this.telegram) {
      const icon = level === "alert" ? "⛔" : level === "warn" ? "⚠️" : "ℹ️";
      await this.telegram(`${icon} ${n.title}${n.body ? `\n${n.body}` : ""}`).catch((err) => console.error("telegram notify:", err));
    }
  }
}

/** The process-wide notifier. */
export const notifier = new Notifier();
export const notify = (n: Notice) => notifier.notify(n);
