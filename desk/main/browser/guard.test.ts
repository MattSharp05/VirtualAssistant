import { describe, expect, it } from "vitest";
import { BROWSER_NEEDS_APPROVAL, BROWSER_NEEDS_MATTHEW, type BrowserTaskGrant } from "@jarvis/shared";
import { checkClick, checkType, fieldInfo, riskyClick, secretField, type GuardTarget } from "./guard";

const button = (name: string, extra: Partial<GuardTarget> = {}): GuardTarget => ({
  role: "button",
  name,
  ...extra,
});
const field = (name: string, extra: Partial<GuardTarget> = {}): GuardTarget => ({
  role: "textbox",
  name,
  ...extra,
});

const normal: BrowserTaskGrant = { taskId: "t1", mode: "normal" };
const full: BrowserTaskGrant = { taskId: "t1", mode: "full" };
const approved: BrowserTaskGrant = { taskId: "t1", mode: "normal", approval: "appr-1" };

describe("riskyClick: buttons that buy, book, pay, confirm, send, post or delete", () => {
  it.each([
    "Place order",
    "Place your order",
    "Pay now",
    "Pay £42.00",
    "Buy now",
    "Book table",
    "Complete booking",
    "Confirm reservation",
    "Send",
    "Send message",
    "Post",
    "Delete account",
    "Delete",
    "Checkout",
    "Proceed to checkout",
    "Purchase",
    "Reserve",
    "Save changes",
  ])("“%s” is risky", (name) => {
    expect(riskyClick(button(name))).toBe(true);
  });

  it.each([
    "Check availability",
    "Search flights",
    "Next",
    "Continue",
    "Show more",
    "Accept cookies",
    "Filter",
    "Sort by price",
    "Resend code",
    "Facebook",
    "Postcode lookup",
    "Add to basket",
  ])("“%s” isn't", (name) => {
    expect(riskyClick(button(name))).toBe(false);
  });

  it("only buttons (and submit inputs) count: a ‘Book’ link only navigates", () => {
    expect(riskyClick({ role: "link", name: "Book" })).toBe(false);
    expect(riskyClick({ role: "menuitem", name: "Delete" })).toBe(true);
    expect(riskyClick({ role: "generic", name: "", inputType: "submit", hints: ["Place order"] })).toBe(true);
  });

  it("an unnamed button is judged by its value or id", () => {
    expect(riskyClick(button("", { hints: ["confirm-payment"] }))).toBe(true);
    expect(riskyClick(button("", { hints: ["menu-toggle"] }))).toBe(false);
  });
});

describe("secretField: what only Matthew types", () => {
  it.each<[GuardTarget, string]>([
    [field("Password"), "password"],
    [field("", { inputType: "password" }), "password"],
    [field("Enter it", { autocomplete: "current-password" }), "password"],
    [field("PIN"), "password"],
    [field("Verification code"), "one-time code"],
    [field("Code", { autocomplete: "one-time-code" }), "one-time code"],
    [field("Enter the 6-digit code"), "one-time code"],
    [field("Card number"), "card details"],
    [field("CVC"), "card details"],
    [field("Expiry date (MM/YY)"), "card details"],
    [field("Name on card"), "card details"],
    [field("Number", { autocomplete: "cc-number" }), "card details"],
    [field("", { hints: ["cardnumber", "1234 1234 1234 1234"], autocomplete: "cc-number" }), "card details"],
  ])("%o is a %s field", (target, kind) => {
    expect(secretField(target)).toBe(kind);
  });

  it.each([field("Email"), field("First name"), field("Party size"), field("Search"), field("Phone number")])(
    "%o isn't",
    (target) => {
      expect(secretField(target)).toBeUndefined();
    },
  );
});

describe("checkClick: Normal mode asks, Full autonomy doesn't", () => {
  it("refuses a risky click in Normal mode without an approval, saying what it would do", () => {
    expect(() => checkClick(button("Place order"), normal)).toThrow(
      `${BROWSER_NEEDS_APPROVAL}: clicking ‘Place order’`,
    );
  });

  it("refuses it outside a task too (no grant is Normal)", () => {
    expect(() => checkClick(button("Place order"), undefined)).toThrow(BROWSER_NEEDS_APPROVAL);
  });

  it("lets it through with Matthew's approval, or in Full autonomy", () => {
    expect(() => checkClick(button("Place order"), approved)).not.toThrow();
    expect(() => checkClick(button("Place order"), full)).not.toThrow();
  });

  it("never stops a harmless click", () => {
    expect(() => checkClick(button("Check availability"), normal)).not.toThrow();
  });
});

describe("checkType: passwords, codes and cards stop in both modes", () => {
  it("refuses typing a password whatever the mode or approval", () => {
    for (const target of [field("Password"), field("", { inputType: "password" })])
      expect(() => checkType(target)).toThrow(`${BROWSER_NEEDS_MATTHEW}:`);
  });

  it("names what's asked for and how Matthew takes over", () => {
    expect(() => checkType(field("Card number"))).toThrow(
      "Matthew types this himself: ‘Card number’ asks for card details. Matthew enters it himself (Take over, then Hand back).",
    );
    expect(() => checkType(field("Verification code"))).toThrow("asks for a one-time code");
  });

  it("lets ordinary fields through", () => {
    expect(() => checkType(field("Email"))).not.toThrow();
  });
});

describe("fieldInfo", () => {
  it("keeps the strings FIELD_INFO answered and drops the rest", () => {
    expect(fieldInfo({ inputType: "password", autocomplete: "", hints: ["pw", 3] })).toEqual({
      inputType: "password",
      hints: ["pw"],
    });
    expect(fieldInfo(undefined)).toEqual({});
    expect(fieldInfo("odd")).toEqual({});
  });
});
