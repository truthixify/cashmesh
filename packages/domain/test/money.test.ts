import { describe, expect, it } from "vitest";

import { MinorUnitError, minorUnits } from "../src/money";

describe("minorUnits", () => {
  it("accepts zero and positive safe integers", () => {
    expect(minorUnits(0)).toBe(0);
    expect(minorUnits(12_345)).toBe(12_345);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid amount %s",
    (value) => {
      expect(() => minorUnits(value)).toThrow(MinorUnitError);
    },
  );
});
