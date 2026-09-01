import { normalizeMintUrl } from "@cashu/cashu-ts";

export const MAX_CASHU_ENDPOINT_LENGTH = 512;

export function normalizeCashuMintUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CASHU_ENDPOINT_LENGTH ||
    value !== value.trim()
  ) {
    throw new Error("Cashu mint URL is invalid.");
  }

  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("Cashu mint URL is unsafe.");
  }

  return normalizeMintUrl(endpoint.toString());
}
