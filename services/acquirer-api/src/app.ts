import type { CashuPaymentRequestIssuer } from "@cashmesh/cashu";
import {
  evaluateOperatorPolicy,
  OPERATOR_TIERS,
  type OperatorTier,
  SETTLEMENT_MODES,
  type SettlementMode,
} from "@cashmesh/domain";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
  LogController,
} from "fastify";

import type { InvoiceRepository } from "./invoice-repository";
import { registerInvoiceRoutes } from "./invoice-routes";
import { InvoiceService, InvoiceServiceError } from "./invoice-service";
import { PaymentIntakeService, PaymentIntakeServiceError } from "./payment-intake-service";
import { registerPaymentRoutes } from "./payment-routes";

interface PolicyRequestBody {
  readonly requestedMode?: SettlementMode;
  readonly tier: OperatorTier;
}

const policyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier"],
  properties: {
    tier: { type: "string", enum: [...OPERATOR_TIERS] },
    requestedMode: { type: "string", enum: [...SETTLEMENT_MODES] },
  },
} as const;

export interface BuildAppOptions {
  readonly cashuPaymentRequestIssuer: Pick<CashuPaymentRequestIssuer, "issue">;
  readonly clock?: () => number;
  readonly invoiceIdFactory?: () => string;
  readonly invoiceRepository: InvoiceRepository;
  readonly logger?: FastifyServerOptions["logger"];
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? false,
  });
  const invoiceService = new InvoiceService(
    options.invoiceRepository,
    options.cashuPaymentRequestIssuer,
    {
      ...(options.clock !== undefined && { clock: options.clock }),
      ...(options.invoiceIdFactory !== undefined && { invoiceIdFactory: options.invoiceIdFactory }),
    },
  );
  const paymentIntakeService = new PaymentIntakeService(options.invoiceRepository, {
    ...(options.clock !== undefined && { clock: options.clock }),
  });

  app.addHook("onClose", async () => options.invoiceRepository.close());
  app.setErrorHandler((error, request, reply) => handleError(error, request.log, reply));

  app.get("/health", async () => ({ service: "acquirer-api", status: "ok" }));

  app.post<{ Body: PolicyRequestBody }>(
    "/v1/operator-policy/evaluate",
    { schema: { body: policyBodySchema } },
    async (request) => evaluateOperatorPolicy(request.body),
  );

  registerInvoiceRoutes(app, invoiceService);
  registerPaymentRoutes(app, paymentIntakeService);

  return app;
}

function handleError(error: unknown, logger: FastifyBaseLogger, reply: FastifyReply): unknown {
  if (hasFastifyCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
    return reply.code(413).send({
      error: { code: "payload_too_large", message: "Request payload is too large." },
    });
  }
  if (hasFastifyCode(error, "FST_ERR_CTP_INVALID_MEDIA_TYPE")) {
    return reply.code(415).send({
      error: { code: "unsupported_media_type", message: "Request media type is unsupported." },
    });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    error.validation !== undefined
  ) {
    return reply.code(400).send({
      error: { code: "invalid_request", message: "Request validation failed." },
    });
  }
  if (error instanceof InvoiceServiceError) {
    const statusCode =
      error.code === "invalid_request"
        ? 400
        : error.code === "invalid_invoice"
          ? 422
          : error.code === "idempotency_conflict"
            ? 409
            : 503;
    if (statusCode === 503) {
      logger.error({ errorName: error.name }, "Invoice request failed.");
    }
    return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof PaymentIntakeServiceError) {
    const statusCode = paymentIntakeStatusCode(error);
    if (error.code === "storage_unavailable") {
      logger.error({ errorName: error.name }, "Cashu payment intake failed.");
    }
    return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
  }

  logger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Unhandled acquirer request failure.",
  );
  return reply.code(500).send({
    error: { code: "internal_error", message: "The request could not be completed." },
  });
}

function hasFastifyCode(error: unknown, code: FastifyError["code"]): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function paymentIntakeStatusCode(error: PaymentIntakeServiceError): number {
  if (error.code === "invalid_payment_payload") {
    return 400;
  }
  if (error.code === "payment_request_not_found") {
    return 404;
  }
  if (error.code === "payment_request_expired") {
    return 410;
  }
  if (
    error.code === "payment_amount_insufficient" ||
    error.code === "payment_mint_not_accepted" ||
    error.code === "payment_unit_not_accepted"
  ) {
    return 422;
  }
  return 503;
}
