import {
  evaluateOperatorPolicy,
  OPERATOR_TIERS,
  type OperatorTier,
  SETTLEMENT_MODES,
  type SettlementMode,
} from "@cashmesh/domain";
import Fastify, { type FastifyInstance } from "fastify";

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

export function buildApp(options: { readonly logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ service: "acquirer-api", status: "ok" }));

  app.post<{ Body: PolicyRequestBody }>(
    "/v1/operator-policy/evaluate",
    { schema: { body: policyBodySchema } },
    async (request) => evaluateOperatorPolicy(request.body),
  );

  return app;
}
