import { describe, expect, it } from "vitest";

import { formatUsdc, parseUsdcAmount } from "../lib/amount";

describe("USDC amount helpers", () => {
  it.each([
    ["0", 0],
    ["1", 100],
    ["12.3", 1_230],
    ["12.34", 1_234],
  ])("parses %s into integer minor units", (value, expected) => {
    expect(parseUsdcAmount(value)).toBe(expected);
  });

  it.each(["", ".5", "1.234", "-1", "1,000", "cash"])("rejects invalid amount %s", (value) => {
    expect(() => parseUsdcAmount(value)).toThrow();
  });

  it("formats minor units without floating-point input", () => {
    expect(formatUsdc(parseUsdcAmount("125.40"))).toBe("USDC 125.40");
  });
});
