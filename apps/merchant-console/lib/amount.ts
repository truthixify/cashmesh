import { type MinorUnitAmount, minorUnits } from "@cashmesh/domain";

const wholeUnitFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const maximumMinorUnits = BigInt(Number.MAX_SAFE_INTEGER);

export function parseUsdcAmount(value: string): MinorUnitAmount {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error("Enter a USDC amount with no more than two decimal places.");
  }

  const wholeDigits = match[1];
  if (wholeDigits === undefined) {
    throw new Error("Amount is missing its whole-unit digits.");
  }

  const whole = BigInt(wholeDigits);
  const fractional = BigInt((match[2] ?? "").padEnd(2, "0"));
  const valueInMinorUnits = whole * 100n + fractional;
  if (valueInMinorUnits > maximumMinorUnits) {
    throw new Error("Amount exceeds the supported minor-unit range.");
  }
  return minorUnits(Number(valueInMinorUnits));
}

export function formatUsdc(value: MinorUnitAmount): string {
  const amount = BigInt(value);
  const whole = amount / 100n;
  const fractional = (amount % 100n).toString().padStart(2, "0");
  return `USDC ${wholeUnitFormatter.format(whole)}.${fractional}`;
}
