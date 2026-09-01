import {
  assertIdentifier,
  assertUnixTimestamp,
  createInvoiceV1,
  evaluateOperatorPolicy,
  INVOICE_SCHEMA_VERSION,
  INVOICE_UNIT,
  type InvoiceId,
  type MinorUnitAmount,
  type OpenInvoiceV1,
  type OperatorId,
  type OperatorTier,
  type PolicyDecision,
  type SettlementMode,
  type UnixTimestamp,
} from "@cashmesh/domain";
import { normalizeMintUrl, PaymentRequest } from "@cashu/cashu-ts";

export const CASHU_PAYMENT_REQUEST_SCHEMA_VERSION = 1 as const;
export const MAX_NUT18_OPERATORS = 16;
export const MAX_NUT18_ENCODED_LENGTH = 4_096;

const MAX_ENDPOINT_LENGTH = 512;
const CASHU_UNIT = "usdc" as const;
const NUT18_MINT_POLICIES = ["strict", "advisory"] as const;
const STELLAR_METHOD = "stellar" as const;

export type Nut18MintPolicy = (typeof NUT18_MINT_POLICIES)[number];

export interface CashuOperatorRoute {
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly requestedMode?: SettlementMode;
  readonly tier: OperatorTier;
}

type AcceptedPolicyDecision = Extract<PolicyDecision, { readonly accepted: true }>;

export interface AcceptedOperatorRouteV1 {
  readonly mintUrl: string;
  readonly mode: SettlementMode;
  readonly operatorId: OperatorId;
  readonly reason: AcceptedPolicyDecision["reason"];
  readonly tier: Exclude<OperatorTier, "unlisted">;
}

export interface CashuPaymentRequestV1 {
  readonly amount: MinorUnitAmount;
  readonly encodedRequest: string;
  readonly encoding: "creqA";
  readonly expiresAt: UnixTimestamp;
  readonly invoiceId: InvoiceId;
  readonly issuedAt: UnixTimestamp;
  readonly mintPolicy: "strict";
  readonly operators: readonly AcceptedOperatorRouteV1[];
  readonly schemaVersion: typeof CASHU_PAYMENT_REQUEST_SCHEMA_VERSION;
  readonly transportUrl: string;
  readonly unit: typeof CASHU_UNIT;
}

export interface CashuPaymentRequestIssuerOptions {
  readonly mintPolicy?: Nut18MintPolicy;
  readonly operators: readonly CashuOperatorRoute[];
  readonly transportUrl: string;
}

export interface IssueCashuPaymentRequestInput {
  readonly invoice: OpenInvoiceV1;
  readonly issuedAt: UnixTimestamp;
}

export interface CreateCashuPaymentRequestInput
  extends CashuPaymentRequestIssuerOptions,
    IssueCashuPaymentRequestInput {}

export type CashuPaymentRequestErrorCode =
  | "advisory_policy_unsupported"
  | "duplicate_mint"
  | "duplicate_operator"
  | "empty_operator_set"
  | "encoding_failed"
  | "invalid_endpoint"
  | "invalid_issued_at"
  | "invalid_invoice"
  | "invalid_mint_policy"
  | "invalid_operator_policy"
  | "invalid_operator_set"
  | "invalid_request"
  | "invoice_expired"
  | "operator_limit_exceeded"
  | "operator_not_accepted"
  | "request_before_invoice"
  | "request_too_large";

export class CashuPaymentRequestError extends Error {
  override readonly name = "CashuPaymentRequestError";

  constructor(
    readonly code: CashuPaymentRequestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class CashuPaymentRequestIssuer {
  private readonly mintPolicy: "strict";
  private readonly operators: readonly AcceptedOperatorRouteV1[];
  private readonly transportUrl: string;

  constructor(options: CashuPaymentRequestIssuerOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new CashuPaymentRequestError(
        "invalid_request",
        "Cashu payment request issuer options must be an object.",
      );
    }
    this.mintPolicy = validateMintPolicy(options.mintPolicy);
    this.operators = Object.freeze(normalizeOperatorRoutes(options.operators));
    this.transportUrl = normalizeHttpsEndpoint(options.transportUrl, "transport");
    ensureEncodedRequestBound(
      encodeCashuPaymentRequest(
        "i".repeat(128),
        Number.MAX_SAFE_INTEGER,
        this.operators,
        this.transportUrl,
      ),
    );
    Object.freeze(this);
  }

  issue(input: IssueCashuPaymentRequestInput): CashuPaymentRequestV1 {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new CashuPaymentRequestError(
        "invalid_request",
        "Cashu payment request input must be an object.",
      );
    }
    const invoice = validateOpenInvoice(input.invoice);
    try {
      assertUnixTimestamp(input.issuedAt);
    } catch {
      throw new CashuPaymentRequestError(
        "invalid_issued_at",
        "Cashu payment request issue time is invalid.",
      );
    }
    if (input.issuedAt < invoice.createdAt) {
      throw new CashuPaymentRequestError(
        "request_before_invoice",
        "Payment request cannot be issued before invoice creation.",
      );
    }
    if (input.issuedAt >= invoice.expiresAt) {
      throw new CashuPaymentRequestError(
        "invoice_expired",
        "Payment request cannot be issued for an expired invoice.",
      );
    }

    const encodedRequest = encodeCashuPaymentRequest(
      invoice.id,
      invoice.amount,
      this.operators,
      this.transportUrl,
    );
    ensureEncodedRequestBound(encodedRequest);

    return Object.freeze({
      amount: invoice.amount,
      encodedRequest,
      encoding: "creqA" as const,
      expiresAt: invoice.expiresAt,
      invoiceId: invoice.id,
      issuedAt: input.issuedAt,
      mintPolicy: this.mintPolicy,
      operators: this.operators,
      schemaVersion: CASHU_PAYMENT_REQUEST_SCHEMA_VERSION,
      transportUrl: this.transportUrl,
      unit: CASHU_UNIT,
    });
  }
}

export function createCashuPaymentRequestV1(
  input: CreateCashuPaymentRequestInput,
): CashuPaymentRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CashuPaymentRequestError(
      "invalid_request",
      "Cashu payment request input must be an object.",
    );
  }
  const issuer = new CashuPaymentRequestIssuer({
    ...(input.mintPolicy !== undefined && { mintPolicy: input.mintPolicy }),
    operators: input.operators,
    transportUrl: input.transportUrl,
  });
  return issuer.issue({ invoice: input.invoice, issuedAt: input.issuedAt });
}

function validateMintPolicy(value: Nut18MintPolicy | undefined): "strict" {
  const mintPolicy = value === undefined ? "strict" : value;
  if (!NUT18_MINT_POLICIES.includes(mintPolicy)) {
    throw new CashuPaymentRequestError("invalid_mint_policy", "NUT-18 mint policy is invalid.");
  }
  if (mintPolicy === "advisory") {
    throw new CashuPaymentRequestError(
      "advisory_policy_unsupported",
      "Advisory NUT-18 requests would promise acceptance of unlisted operators.",
    );
  }
  return mintPolicy;
}

function normalizeEncodedCreqA(value: string): string {
  if (!/^creqA[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new CashuPaymentRequestError(
      "encoding_failed",
      "Cashu payment request encoder returned an invalid creqA value.",
    );
  }
  return `creqA${value.slice(5).replaceAll("+", "-").replaceAll("/", "_")}`;
}

function encodeCashuPaymentRequest(
  invoiceId: string,
  amount: number,
  operators: readonly AcceptedOperatorRouteV1[],
  transportUrl: string,
): string {
  return normalizeEncodedCreqA(
    PaymentRequest.builder()
      .id(invoiceId)
      .amount(amount, CASHU_UNIT)
      .addMint(operators.map((operator) => operator.mintUrl))
      .addSupportedMethod(STELLAR_METHOD)
      .addHttpPostTransport(transportUrl)
      .singleUse()
      .build()
      .toEncodedCreqA(),
  );
}

function ensureEncodedRequestBound(value: string): void {
  if (value.length > MAX_NUT18_ENCODED_LENGTH) {
    throw new CashuPaymentRequestError(
      "request_too_large",
      "Encoded payment request exceeds the CashMesh transport bound.",
    );
  }
}

function validateOpenInvoice(invoice: OpenInvoiceV1): OpenInvoiceV1 {
  if (
    typeof invoice !== "object" ||
    invoice === null ||
    Array.isArray(invoice) ||
    invoice.schemaVersion !== INVOICE_SCHEMA_VERSION ||
    invoice.unit !== INVOICE_UNIT ||
    invoice.state !== "open"
  ) {
    throw new CashuPaymentRequestError(
      "invalid_invoice",
      "Cashu payment requests require an open version 1 USDC invoice.",
    );
  }
  try {
    return createInvoiceV1({
      amount: invoice.amount,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      id: invoice.id,
      merchantId: invoice.merchantId,
    });
  } catch {
    throw new CashuPaymentRequestError(
      "invalid_invoice",
      "Cashu payment request invoice fields are invalid.",
    );
  }
}

function normalizeOperatorRoutes(routes: readonly CashuOperatorRoute[]): AcceptedOperatorRouteV1[] {
  if (!Array.isArray(routes)) {
    throw new CashuPaymentRequestError(
      "invalid_operator_set",
      "Cashu operator routes must be an array.",
    );
  }
  if (routes.length === 0) {
    throw new CashuPaymentRequestError(
      "empty_operator_set",
      "A strict NUT-18 request requires at least one accepted operator.",
    );
  }
  if (routes.length > MAX_NUT18_OPERATORS) {
    throw new CashuPaymentRequestError(
      "operator_limit_exceeded",
      `A NUT-18 request supports at most ${MAX_NUT18_OPERATORS} operators.`,
    );
  }

  const operatorIds = new Set<string>();
  const mintUrls = new Set<string>();
  const normalized = routes.map((route) => {
    if (typeof route !== "object" || route === null || Array.isArray(route)) {
      throw new CashuPaymentRequestError(
        "invalid_operator_policy",
        "Cashu operator route must be an object.",
      );
    }
    try {
      assertIdentifier(route.operatorId, "operator id");
    } catch {
      throw new CashuPaymentRequestError(
        "invalid_operator_policy",
        "Cashu operator route has an invalid operator identifier.",
      );
    }
    if (operatorIds.has(route.operatorId)) {
      throw new CashuPaymentRequestError(
        "duplicate_operator",
        `Operator ${route.operatorId} appears more than once.`,
      );
    }
    operatorIds.add(route.operatorId);

    const mintUrl = normalizeHttpsEndpoint(route.mintUrl, "mint");
    if (mintUrls.has(mintUrl)) {
      throw new CashuPaymentRequestError(
        "duplicate_mint",
        "One mint URL cannot represent more than one operator route.",
      );
    }
    mintUrls.add(mintUrl);

    let decision: PolicyDecision;
    try {
      decision = evaluateOperatorPolicy({
        ...(route.requestedMode !== undefined && { requestedMode: route.requestedMode }),
        tier: route.tier,
      });
    } catch {
      throw new CashuPaymentRequestError(
        "invalid_operator_policy",
        `Operator ${route.operatorId} has an invalid policy configuration.`,
      );
    }
    if (!decision.accepted || route.tier === "unlisted") {
      throw new CashuPaymentRequestError(
        "operator_not_accepted",
        `Operator ${route.operatorId} is not accepted by merchant policy.`,
      );
    }
    return Object.freeze({
      mintUrl,
      mode: decision.mode,
      operatorId: route.operatorId,
      reason: decision.reason,
      tier: route.tier,
    });
  });

  return normalized.sort((left, right) => {
    if (left.mintUrl < right.mintUrl) {
      return -1;
    }
    if (left.mintUrl > right.mintUrl) {
      return 1;
    }
    return 0;
  });
}

function normalizeHttpsEndpoint(value: string, kind: "mint" | "transport"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_LENGTH ||
    value !== value.trim()
  ) {
    throw new CashuPaymentRequestError(
      "invalid_endpoint",
      `${kind} URL has an invalid length or surrounding whitespace.`,
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new CashuPaymentRequestError("invalid_endpoint", `${kind} URL is invalid.`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new CashuPaymentRequestError(
      "invalid_endpoint",
      `${kind} URL must use HTTPS without credentials, query parameters, or fragments.`,
    );
  }

  try {
    return kind === "mint" ? normalizeMintUrl(endpoint.toString()) : endpoint.toString();
  } catch {
    throw new CashuPaymentRequestError("invalid_endpoint", `${kind} URL is invalid.`);
  }
}
