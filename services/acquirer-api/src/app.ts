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
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
  LogController,
} from "fastify";

import type { InvoiceRepository } from "./invoice-repository";
import { registerInvoiceRoutes } from "./invoice-routes";
import { InvoiceService, InvoiceServiceError } from "./invoice-service";

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

  app.addHook("onClose", async () => options.invoiceRepository.close());
  app.setErrorHandler((error, request, reply) => handleError(error, request.log, reply));

  app.get("/health", async () => ({ service: "acquirer-api", status: "ok" }));

  app.post<{ Body: PolicyRequestBody }>(
    "/v1/operator-policy/evaluate",
    { schema: { body: policyBodySchema } },
    async (request) => evaluateOperatorPolicy(request.body),
  );

  registerInvoiceRoutes(app, invoiceService);

  return app;
}

function handleError(error: unknown, logger: FastifyBaseLogger, reply: FastifyReply): unknown {
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

  logger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Unhandled acquirer request failure.",
  );
  return reply.code(500).send({
    error: { code: "internal_error", message: "The request could not be completed." },
  });
}
