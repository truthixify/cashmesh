import {
  type CashuOperatorRoute,
  CashuPaymentRequestIssuer,
  type CashuStellarSettlementDestination,
  cashuStellarSettlementDestination,
} from "@cashmesh/cashu";
import {
  OPERATOR_TIERS,
  type OperatorTier,
  operatorId,
  SETTLEMENT_MODES,
  type SettlementMode,
} from "@cashmesh/domain";

const LOCAL_TRANSPORT_URL = "https://pay.cashmesh.example/v1/cashu/payments";
const LOCAL_STELLAR_SETTLEMENT_DESTINATION =
  "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const LOCAL_OPERATOR_ROUTES: readonly CashuOperatorRoute[] = Object.freeze([
  Object.freeze({
    mintUrl: "https://mint-a.cashmesh.example",
    operatorId: operatorId("operator-local-a"),
    tier: "trusted" as const,
  }),
  Object.freeze({
    mintUrl: "https://mint-b.cashmesh.example",
    operatorId: operatorId("operator-local-b"),
    tier: "convertible" as const,
  }),
]);

type Environment = Readonly<Record<string, string | undefined>>;

export class CashuConfigurationError extends Error {
  override readonly name = "CashuConfigurationError";
  readonly code = "invalid_cashu_configuration" as const;

  constructor() {
    super("Cashu payment request configuration is invalid.");
  }
}

export function cashuPaymentRequestIssuerFromEnvironment(
  environment: Environment,
): CashuPaymentRequestIssuer {
  try {
    const production = environment.NODE_ENV === "production";
    const transportUrl = readValue(
      environment.CASHMESH_CASHU_TRANSPORT_URL,
      production ? undefined : LOCAL_TRANSPORT_URL,
    );
    const routesValue = readValue(environment.CASHMESH_CASHU_OPERATOR_ROUTES, undefined);
    const operators =
      routesValue === undefined
        ? production
          ? failConfiguration()
          : LOCAL_OPERATOR_ROUTES
        : parseOperatorRoutes(routesValue);

    if (transportUrl === undefined) {
      return failConfiguration();
    }
    return new CashuPaymentRequestIssuer({ operators, transportUrl });
  } catch {
    throw new CashuConfigurationError();
  }
}

export function cashuStellarSettlementDestinationFromEnvironment(
  environment: Environment,
): CashuStellarSettlementDestination {
  try {
    const value = readValue(
      environment.CASHMESH_STELLAR_SETTLEMENT_DESTINATION,
      environment.NODE_ENV === "production" ? undefined : LOCAL_STELLAR_SETTLEMENT_DESTINATION,
    );
    if (value === undefined) {
      return failConfiguration();
    }
    return cashuStellarSettlementDestination(value);
  } catch {
    throw new CashuConfigurationError();
  }
}

function readValue(value: string | undefined, fallback: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? fallback : value;
}

function parseOperatorRoutes(value: string): readonly CashuOperatorRoute[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    return failConfiguration();
  }
  return Object.freeze(parsed.map(parseOperatorRoute));
}

function parseOperatorRoute(value: unknown): CashuOperatorRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failConfiguration();
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["mintUrl", "operatorId", "requestedMode", "tier"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return failConfiguration();
  }
  if (
    typeof record.mintUrl !== "string" ||
    typeof record.operatorId !== "string" ||
    !isOperatorTier(record.tier) ||
    (record.requestedMode !== undefined && !isSettlementMode(record.requestedMode))
  ) {
    return failConfiguration();
  }

  return Object.freeze({
    mintUrl: record.mintUrl,
    operatorId: operatorId(record.operatorId),
    ...(record.requestedMode !== undefined && { requestedMode: record.requestedMode }),
    tier: record.tier,
  });
}

function isOperatorTier(value: unknown): value is OperatorTier {
  return typeof value === "string" && OPERATOR_TIERS.includes(value as OperatorTier);
}

function isSettlementMode(value: unknown): value is SettlementMode {
  return typeof value === "string" && SETTLEMENT_MODES.includes(value as SettlementMode);
}

function failConfiguration(): never {
  throw new CashuConfigurationError();
}
