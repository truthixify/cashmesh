"use client";

import { evaluateOperatorPolicy, type MinorUnitAmount, minorUnits } from "@cashmesh/domain";
import {
  Activity,
  ArrowDownToLine,
  CircleDollarSign,
  CreditCard,
  FileText,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Store,
  Trash2,
  Users,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";

import { formatUsdc, parseUsdcAmount } from "../lib/amount";
import { Button } from "./ui/button";

type PaymentState = "awaiting_payment" | "paid" | "settled";

interface OperatorFixture {
  readonly id: string;
  readonly name: string;
  readonly reserveLabel: string;
  readonly tier: "trusted" | "convertible";
}

interface PaymentFixture {
  readonly amount: MinorUnitAmount;
  readonly id: string;
  readonly mode: "trusted_hold" | "immediate_conversion";
  readonly operator: string;
  readonly orderReference: string;
  readonly state: PaymentState;
}

const operators = [
  {
    id: "atlas",
    name: "Atlas Community",
    reserveLabel: "Reserve observed 2m ago",
    tier: "trusted",
  },
  {
    id: "meridian",
    name: "Meridian Labs",
    reserveLabel: "Redemption checked 6m ago",
    tier: "convertible",
  },
] as const satisfies readonly OperatorFixture[];

const initialPayments: readonly PaymentFixture[] = [
  {
    id: "INV-1042",
    orderReference: "ORDER-3881",
    amount: minorUnits(8_450),
    operator: "Atlas Community",
    mode: "trusted_hold",
    state: "settled",
  },
  {
    id: "INV-1041",
    orderReference: "ORDER-3879",
    amount: minorUnits(2_500),
    operator: "Meridian Labs",
    mode: "immediate_conversion",
    state: "paid",
  },
  {
    id: "INV-1040",
    orderReference: "ORDER-3874",
    amount: minorUnits(12_000),
    operator: "Atlas Community",
    mode: "trusted_hold",
    state: "settled",
  },
];

const stateLabels: Record<PaymentState, string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Pending settlement",
  settled: "Settled",
};

const stateClasses: Record<PaymentState, string> = {
  awaiting_payment: "bg-warning-soft text-warning",
  paid: "bg-info-soft text-info",
  settled: "bg-success-soft text-success",
};

function selectedOperator(id: string): OperatorFixture {
  const operator = operators.find((candidate) => candidate.id === id);
  if (!operator) {
    throw new Error("Selected operator is unavailable.");
  }
  return operator;
}

export function MerchantDashboard() {
  const nextInvoice = useRef(1043);
  const [payments, setPayments] = useState<readonly PaymentFixture[]>(initialPayments);
  const [amount, setAmount] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [operatorId, setOperatorId] = useState<string>(operators[0].id);
  const [requestedMode, setRequestedMode] = useState<"trusted_hold" | "immediate_conversion">(
    "trusted_hold",
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const accepted = payments.reduce((sum, payment) => sum + payment.amount, 0);
    const awaitingSettlement = payments
      .filter((payment) => payment.state !== "settled")
      .reduce((sum, payment) => sum + payment.amount, 0);
    return { accepted: minorUnits(accepted), awaitingSettlement: minorUnits(awaitingSettlement) };
  }, [payments]);

  function changeOperator(id: string) {
    const operator = selectedOperator(id);
    setOperatorId(id);
    if (operator.tier === "convertible") {
      setRequestedMode("immediate_conversion");
    }
  }

  function createInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    try {
      const parsedAmount = parseUsdcAmount(amount);
      if (parsedAmount === 0) {
        throw new Error("Amount must be greater than zero.");
      }

      const operator = selectedOperator(operatorId);
      const decision = evaluateOperatorPolicy({ tier: operator.tier, requestedMode });
      if (!decision.accepted) {
        throw new Error("The selected operator is not accepted for this merchant.");
      }

      const id = `INV-${nextInvoice.current}`;
      nextInvoice.current += 1;
      setPayments((current) => [
        {
          id,
          orderReference: orderReference.trim() || "No order reference",
          amount: parsedAmount,
          operator: operator.name,
          mode: decision.mode,
          state: "awaiting_payment",
        },
        ...current,
      ]);
      setAmount("");
      setOrderReference("");
      setNotice(`${id} is ready for wallet presentation.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invoice could not be created.");
    }
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="border-b border-border bg-card lg:min-h-screen lg:border-r lg:border-b-0">
        <div className="flex h-16 items-center gap-3 border-b border-border px-4 lg:px-5">
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <WalletCards className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">CashMesh</p>
            <p className="truncate text-xs text-muted-foreground">Merchant operations</p>
          </div>
        </div>

        <nav
          className="grid grid-cols-4 gap-1 p-2 lg:block lg:space-y-1 lg:p-3"
          aria-label="Primary"
        >
          <a
            href="#overview"
            aria-current="page"
            className="flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md bg-muted px-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:flex-row sm:gap-2 sm:px-3 sm:text-sm lg:justify-start lg:gap-3"
          >
            <LayoutDashboard className="size-4" aria-hidden="true" /> Overview
          </a>
          <a
            href="#payments"
            className="flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:flex-row sm:gap-2 sm:px-3 sm:text-sm lg:justify-start lg:gap-3"
          >
            <CreditCard className="size-4" aria-hidden="true" /> Payments
          </a>
          <a
            href="#operators"
            className="flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:flex-row sm:gap-2 sm:px-3 sm:text-sm lg:justify-start lg:gap-3"
          >
            <Users className="size-4" aria-hidden="true" /> Operators
          </a>
          <a
            href="#settlements"
            className="flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:flex-row sm:gap-2 sm:px-3 sm:text-sm lg:justify-start lg:gap-3"
          >
            <ArrowDownToLine className="size-4" aria-hidden="true" /> Settlements
          </a>
        </nav>

        <div className="hidden border-t border-border p-4 lg:fixed lg:bottom-0 lg:block lg:w-[231px]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-success" aria-hidden="true" />
            Stellar testnet fixture
          </div>
        </div>
      </aside>

      <main className="min-w-0" id="overview">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6 lg:px-8">
          <div>
            <h1 className="text-xl font-semibold">Merchant overview</h1>
            <p className="text-sm text-muted-foreground">Harbor Market / Lagos</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 items-center rounded-full bg-warning-soft px-3 text-xs font-medium text-warning">
              Fixture data
            </span>
            <Button
              type="button"
              onClick={() => document.getElementById("invoice-amount")?.focus()}
            >
              <Plus className="size-4" aria-hidden="true" /> New invoice
            </Button>
          </div>
        </header>

        <section
          className="grid border-b border-border sm:grid-cols-3"
          aria-label="Account summary"
        >
          <div className="border-b border-border px-4 py-5 sm:border-r sm:border-b-0 md:px-6 lg:px-8">
            <p className="text-xs font-medium text-muted-foreground">Accepted volume</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {formatUsdc(metrics.accepted)}
            </p>
          </div>
          <div className="border-b border-border px-4 py-5 sm:border-r sm:border-b-0 md:px-6">
            <p className="text-xs font-medium text-muted-foreground">Awaiting settlement</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {formatUsdc(metrics.awaitingSettlement)}
            </p>
          </div>
          <div className="px-4 py-5 md:px-6">
            <p className="text-xs font-medium text-muted-foreground">Accepting operators</p>
            <div className="mt-2 flex items-baseline gap-2">
              <p className="font-mono text-2xl font-semibold tabular-nums">{operators.length}</p>
              <span className="text-xs text-muted-foreground">1 hold / 1 convert</span>
            </div>
          </div>
        </section>

        <div className="grid min-w-0 gap-8 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)] lg:px-8">
          <div className="min-w-0 space-y-8">
            <section id="payments" aria-labelledby="payments-heading">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 id="payments-heading" className="text-base font-semibold">
                    Recent payments
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Current testnet workspace activity
                  </p>
                </div>
                {payments.length > 0 ? (
                  <Button type="button" variant="ghost" onClick={() => setPayments([])}>
                    <Trash2 className="size-4" aria-hidden="true" /> Clear
                  </Button>
                ) : null}
              </div>

              {payments.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center border-y border-border py-10 text-center">
                  <FileText className="size-9 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">No payment activity</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create an invoice or restore the fixture set.
                  </p>
                  <Button
                    className="mt-4"
                    type="button"
                    variant="secondary"
                    onClick={() => setPayments(initialPayments)}
                  >
                    <RefreshCw className="size-4" aria-hidden="true" /> Restore fixtures
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border border-y border-border md:hidden">
                  {payments.map((payment) => (
                    <article
                      key={payment.id}
                      data-testid={`payment-${payment.id}`}
                      className="bg-card px-3 py-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-mono text-xs font-medium">{payment.id}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {payment.orderReference}
                          </p>
                        </div>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${stateClasses[payment.state]}`}
                        >
                          {stateLabels[payment.state]}
                        </span>
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Amount</dt>
                          <dd className="mt-1 font-mono font-medium tabular-nums">
                            {formatUsdc(payment.amount)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Operator</dt>
                          <dd className="mt-1 font-medium">{payment.operator}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Settlement</dt>
                          <dd className="mt-1 font-medium">
                            {payment.mode === "trusted_hold"
                              ? "Trusted hold"
                              : "Immediate conversion"}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}

              {payments.length > 0 ? (
                <div className="hidden overflow-x-auto border-y border-border md:block">
                  <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                    <thead className="bg-muted text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-3 font-medium" scope="col">
                          Invoice
                        </th>
                        <th className="px-3 py-3 font-medium" scope="col">
                          Amount
                        </th>
                        <th className="px-3 py-3 font-medium" scope="col">
                          Operator
                        </th>
                        <th className="px-3 py-3 font-medium" scope="col">
                          Settlement
                        </th>
                        <th className="px-3 py-3 font-medium" scope="col">
                          State
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment) => (
                        <tr
                          key={payment.id}
                          data-testid={`payment-${payment.id}`}
                          className="border-t border-border bg-card"
                        >
                          <td className="px-3 py-3">
                            <p className="font-mono text-xs font-medium">{payment.id}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {payment.orderReference}
                            </p>
                          </td>
                          <td className="px-3 py-3 font-mono font-medium tabular-nums">
                            {formatUsdc(payment.amount)}
                          </td>
                          <td className="px-3 py-3">{payment.operator}</td>
                          <td className="px-3 py-3 text-muted-foreground">
                            {payment.mode === "trusted_hold"
                              ? "Trusted hold"
                              : "Immediate conversion"}
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${stateClasses[payment.state]}`}
                            >
                              {stateLabels[payment.state]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>

            <section id="operators" aria-labelledby="operators-heading">
              <div className="mb-3">
                <h2 id="operators-heading" className="text-base font-semibold">
                  Operator policy
                </h2>
                <p className="text-xs text-muted-foreground">
                  Merchant-specific acceptance and settlement
                </p>
              </div>
              <div className="divide-y divide-border border-y border-border bg-card">
                {operators.map((operator) => (
                  <div
                    key={operator.id}
                    className="flex flex-wrap items-center justify-between gap-4 px-3 py-4"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted">
                        <Store className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{operator.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {operator.reserveLabel}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${operator.tier === "trusted" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
                      >
                        {operator.tier === "trusted" ? "Trusted / hold" : "Convert only"}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">Limit USDC 250.00</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside
            id="settlements"
            className="self-start border border-border bg-card p-4 md:p-5"
            aria-labelledby="invoice-heading"
          >
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
                <CircleDollarSign className="size-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="invoice-heading" className="text-base font-semibold">
                  Create test invoice
                </h2>
                <p className="text-xs text-muted-foreground">Stellar testnet / USDC minor units</p>
              </div>
            </div>

            <form className="mt-6 space-y-4" onSubmit={createInvoice} noValidate>
              <div className="space-y-1.5">
                <label htmlFor="invoice-amount" className="block text-sm font-medium">
                  Amount (required)
                </label>
                <div className="flex">
                  <span className="inline-flex h-10 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                    USDC
                  </span>
                  <input
                    id="invoice-amount"
                    name="amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="25.00"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "invoice-error" : "invoice-amount-hint"}
                    className="h-10 min-w-0 flex-1 rounded-r-md border border-input bg-background px-3 font-mono text-sm tabular-nums placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <p id="invoice-amount-hint" className="text-xs text-muted-foreground">
                  Two decimal places maximum
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="order-reference" className="block text-sm font-medium">
                  Order reference
                </label>
                <input
                  id="order-reference"
                  name="orderReference"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="ORDER-3882"
                  value={orderReference}
                  onChange={(event) => setOrderReference(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="operator" className="block text-sm font-medium">
                  Operator
                </label>
                <select
                  id="operator"
                  name="operator"
                  value={operatorId}
                  onChange={(event) => changeOperator(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {operators.map((operator) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.name}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Settlement mode</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className={`flex min-h-10 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-xs font-medium focus-within:ring-2 focus-within:ring-ring ${requestedMode === "trusted_hold" ? "border-primary bg-success-soft text-success" : "border-input bg-background text-muted-foreground"} ${selectedOperator(operatorId).tier === "convertible" ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="settlementMode"
                      value="trusted_hold"
                      checked={requestedMode === "trusted_hold"}
                      disabled={selectedOperator(operatorId).tier === "convertible"}
                      onChange={() => setRequestedMode("trusted_hold")}
                    />
                    Trusted hold
                  </label>
                  <label
                    className={`flex min-h-10 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-xs font-medium focus-within:ring-2 focus-within:ring-ring ${requestedMode === "immediate_conversion" ? "border-primary bg-info-soft text-info" : "border-input bg-background text-muted-foreground"}`}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="settlementMode"
                      value="immediate_conversion"
                      checked={requestedMode === "immediate_conversion"}
                      onChange={() => setRequestedMode("immediate_conversion")}
                    />
                    Convert now
                  </label>
                </div>
              </fieldset>

              {error ? (
                <p
                  id="invoice-error"
                  role="alert"
                  className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger"
                >
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p
                  role="status"
                  className="rounded-md bg-success-soft px-3 py-2 text-xs text-success"
                >
                  {notice}
                </p>
              ) : null}

              <Button className="w-full" type="submit">
                <Plus className="size-4" aria-hidden="true" /> Create invoice
              </Button>
            </form>

            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Merchant settlement</span>
                <span className="font-medium">Stellar USDC</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Acquirer fee</span>
                <span className="font-mono tabular-nums">0.60%</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Workspace</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-success">
                  <Activity className="size-3.5" aria-hidden="true" /> Testnet
                </span>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
