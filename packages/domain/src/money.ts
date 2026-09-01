declare const minorUnitBrand: unique symbol;

export type MinorUnitAmount = number & { readonly [minorUnitBrand]: true };

export class MinorUnitError extends Error {
  override readonly name = "MinorUnitError";
}

export function minorUnits(value: number): MinorUnitAmount {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MinorUnitError("Minor-unit amounts must be non-negative safe integers.");
  }

  return value as MinorUnitAmount;
}
