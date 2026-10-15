// @vitest-environment node
import { expect, it } from "vitest";
import { parseSayVoices } from "./voices";

it("parses `say -v ?`, names with spaces and brackets included", () => {
  const out = [
    "Daniel              en_GB    # Hello! My name is Daniel.",
    "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
    "Karen               en_AU    # Hi my name is Karen",
    "Grandma (Deutsch (Deutschland)) de_DE    # Hallo! Ich heiße Grandma.",
    "",
    "garbage line",
  ].join("\n");
  expect(parseSayVoices(out)).toEqual([
    { name: "Daniel", locale: "en_GB", sample: "Hello! My name is Daniel." },
    { name: "Eddy (English (UK))", locale: "en_GB", sample: "Hello! My name is Eddy." },
    { name: "Karen", locale: "en_AU", sample: "Hi my name is Karen" },
    { name: "Grandma (Deutsch (Deutschland))", locale: "de_DE", sample: "Hallo! Ich heiße Grandma." },
  ]);
});
