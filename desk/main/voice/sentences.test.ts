// @vitest-environment node
import { describe, expect, it } from "vitest";
import { firstClause, SentenceSplitter, speakable, splitLine } from "./sentences";

/** Streams `text` in chunks of `size` characters, then flushes: every sentence, in order. */
function stream(text: string, size = 3): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  return [...out, ...s.flush()];
}

describe("SentenceSplitter", () => {
  it("hands out each sentence as soon as it's complete", () => {
    const s = new SentenceSplitter();
    expect(s.push("You have three meetings")).toEqual([]);
    expect(s.push(" today. The first")).toEqual(["You have three meetings today."]);
    expect(s.push(" is at ten! Anything")).toEqual(["The first is at ten!"]);
    expect(s.push(" else?")).toEqual([]); // "?" at the end: wait to see what follows
    expect(s.flush()).toEqual(["Anything else?"]);
  });

  it("doesn't end a sentence at an abbreviation like e.g. or Dr.", () => {
    expect(stream("Bring something, e.g. the slides. Then call Dr. Patel at noon. Done.")).toEqual([
      "Bring something, e.g. the slides.",
      "Then call Dr. Patel at noon.",
      "Done.",
    ]);
    expect(stream("Pick one, i.e. the cheaper. Ok.")).toEqual(["Pick one, i.e. the cheaper.", "Ok."]);
  });

  it("ends at a.m. or etc. only before a capital", () => {
    expect(stream("Standup is at 9 a.m. tomorrow. Lunch at 1 p.m. Then gym.")).toEqual([
      "Standup is at 9 a.m. tomorrow.",
      "Lunch at 1 p.m.",
      "Then gym.",
    ]);
    expect(stream("Milk, eggs, etc. are on the list.")).toEqual(["Milk, eggs, etc. are on the list."]);
  });

  it("keeps decimals, times, versions and URLs whole, however they're chunked", () => {
    const text = "It costs 3.50 today. Meet at 10:30 or 10.45. Version 2.1.4 shipped.";
    const want = ["It costs 3.50 today.", "Meet at 10:30 or 10.45.", "Version 2.1.4 shipped."];
    for (const size of [1, 2, 5, 100]) expect(stream(text, size)).toEqual(want);
    expect(stream("See example.com/a.b for it. Yes.")).toEqual(["See example.com/a.b for it.", "Yes."]);
  });

  it("waits at a full stop that may still become a decimal", () => {
    const s = new SentenceSplitter();
    expect(s.push("That's 3.")).toEqual([]);
    expect(s.push("5 hours. ")).toEqual(["That's 3.5 hours."]);
  });

  it("reads list items and headings as sentences, without their markers", () => {
    const text =
      "## Today\nHere's your day:\n- Standup at 9:30\n- **Lunch** with Sam.\n1. Ship JD-38\n2. Review PRs";
    expect(stream(text)).toEqual([
      "Today",
      "Here's your day:",
      "Standup at 9:30",
      "Lunch with Sam.",
      "Ship JD-38",
      "Review PRs",
    ]);
  });

  it("doesn't end a list item at its number", () => {
    expect(stream("1. First thing. Then more.\n2. Second")).toEqual(["First thing.", "Then more.", "Second"]);
  });

  it("skips fenced code blocks entirely", () => {
    const text = "Here's the fix.\n```ts\nconst x = 1. y();\nfoo.bar();\n```\nRun it again. Done.";
    for (const size of [1, 4, 100])
      expect(stream(text, size)).toEqual(["Here's the fix.", "Run it again.", "Done."]);
  });

  it("drops an unclosed code block at the end", () => {
    expect(stream("Try this:\n```\nrm -rf build")).toEqual(["Try this:"]);
  });

  it("starts fresh after a flush", () => {
    const s = new SentenceSplitter();
    s.push("```\ncode");
    expect(s.flush()).toEqual([]);
    expect([...s.push("Hello there. "), ...s.flush()]).toEqual(["Hello there."]);
  });
});

describe("splitLine", () => {
  it("returns what's left after the complete sentences", () => {
    expect(splitLine("One. Two", false)).toEqual({ sentences: ["One."], rest: "Two" });
    expect(splitLine("One. Two", true)).toEqual({ sentences: ["One."], rest: "Two" });
  });
});

describe("speakable", () => {
  it("keeps a link's text and drops URLs", () => {
    expect(speakable("Read [the PRD](https://notion.so/abc) first.")).toBe("Read the PRD first.");
    expect(speakable("It's at https://github.com/x/y/pull/12 now.")).toBe("It's at now.");
    expect(speakable("<https://example.com>")).toBe("");
  });

  it("strips markdown emphasis, inline code, quotes, tables and emoji", () => {
    expect(speakable("**Booked** your _call_ with `Sam` ✅")).toBe("Booked your call with Sam");
    expect(speakable("> Note: it's ~~late~~ fine")).toBe("Note: it's late fine");
    expect(speakable("| 9:30 | Standup |")).toBe("9:30, Standup");
    expect(speakable("|---|:---:|")).toBe("");
    expect(speakable("---")).toBe("");
  });

  it("drops stray markdown symbols but keeps dashes", () => {
    expect(speakable("Use 2*3 today")).toBe("Use 2 3 today");
    expect(speakable("Plan - then act.")).toBe("Plan - then act.");
  });
});

describe("first clause (JD-48)", () => {
  const long = "You have three meetings this afternoon, starting with the design review at two";

  it("hands out a long first sentence up to its last comma, then carries on as usual", () => {
    const s = new SentenceSplitter({ firstClauseChars: 60 });
    expect(s.push(long.slice(0, 50))).toEqual([]);
    expect(s.push(long.slice(50))).toEqual(["You have three meetings this afternoon,"]);
    expect(s.said).toBe(1);
    expect(s.push(", then the standup, then lunch")).toEqual([]); // only the first sentence is cut
    expect(s.push(". Anything else?")).toEqual([
      "starting with the design review at two, then the standup, then lunch.",
    ]);
    expect(s.flush()).toEqual(["Anything else?"]);
    expect(s.said).toBe(3);
    // The next reply (after a flush) may cut its first sentence again.
    expect(s.push(long)).toEqual(["You have three meetings this afternoon,"]);
  });

  it("leaves short sentences, and splitters without the option, alone", () => {
    expect(new SentenceSplitter({ firstClauseChars: 60 }).push("Sure, one moment")).toEqual([]);
    expect(new SentenceSplitter().push(long)).toEqual([]);
  });

  it("cuts only after 20 characters, never inside a link, code or emphasis, or in 1,000 or 10:30", () => {
    expect(firstClause(long, 60)).toEqual({
      text: "You have three meetings this afternoon,",
      rest: "starting with the design review at two",
    });
    expect(firstClause(long, 100)).toBeUndefined();
    expect(firstClause("Yes, so that's 1,000 people at 10:30 in the main hall today", 40)).toBeUndefined();
    expect(
      firstClause("Look at [the plan, the draft, and the notes](https://x.y) before Friday", 40),
    ).toBeUndefined();
    expect(firstClause("The **budget, as agreed, is** still open for the whole team", 40)).toBeUndefined();
    expect(firstClause("Your calendar is clear this morning; the afternoon is busy with calls", 40)).toEqual({
      text: "Your calendar is clear this morning;",
      rest: "the afternoon is busy with calls",
    });
  });
});
