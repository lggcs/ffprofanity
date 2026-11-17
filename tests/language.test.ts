import { describe, expect, it } from "vitest";
import { getLanguageName, languageDisplayName } from "../src/lib/language";

describe("language display names", () => {
  it("maps ISO 639-2/B codes the relays deliver", () => {
    expect(languageDisplayName("scc")).toBe("Serbian (Cyrillic)");
    expect(languageDisplayName("scr")).toBe("Croatian");
    expect(languageDisplayName("rum")).toBe("Romanian");
    expect(languageDisplayName("ell")).toBe("Greek");
    expect(languageDisplayName("el")).toBe("Greek");
    expect(languageDisplayName("slk")).toBe("Slovak");
  });

  it("resolves full language names a relay may use as the language field", () => {
    expect(languageDisplayName("Croatian")).toBe("Croatian");
    // 2-char truncation would hit the wrong language for these:
    // "Slovak" → "sl" (Slovenian), "Armenian" → "ar" (Arabic).
    expect(languageDisplayName("Slovak")).toBe("Slovak");
    expect(languageDisplayName("Armenian")).toBe("Armenian");
  });

  it("resolves region-suffixed codes", () => {
    expect(languageDisplayName("en-US")).toBe("English");
    expect(languageDisplayName("zh-CN")).toBe("Chinese (Simplified)");
  });

  it("still masks only genuinely unknown codes", () => {
    expect(getLanguageName("en")).toBe("English");
    expect(getLanguageName("unknown")).toBe("UNKNOWN");
    expect(languageDisplayName("klingon")).toBeNull();
  });
});
