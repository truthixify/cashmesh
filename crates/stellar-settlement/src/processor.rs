use std::collections::HashMap;
use std::error::Error;
use std::fmt::{Debug, Formatter};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use cdk_common::payment::{
    CreateIncomingPaymentResponse, Error as CdkPaymentError, Event, IncomingPaymentOptions,
    MakePaymentResponse, MintPayment, OutgoingPaymentOptions, PaymentIdentifier,
    PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::{Amount, CurrencyUnit, MeltQuoteState, QuoteId};
use futures::{Stream, stream};
use serde_json::json;
use tokio::sync::watch;

use crate::{
    LedgerCursor, MeltQuoteRecord, MintQuoteRecord, ObservedPayment, QuoteReference, Sep7Payment,
    Settlement, SettlementState, StateStore, StellarProfile, TransactionHash, UsdcMinorUnits,
    build_deposit_request, parse_payment_request,
};

pub type ExternalError = Box<dyn Error + Send + Sync>;

pub trait Clock: Send + Sync {
    fn unix_seconds(&self) -> u64;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn unix_seconds(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs())
    }
}

#[derive(Debug)]
pub struct FixedClock(AtomicU64);

impl FixedClock {
    #[must_use]
    pub const fn new(unix_seconds: u64) -> Self {
        Self(AtomicU64::new(unix_seconds))
    }

    pub fn set(&self, unix_seconds: u64) {
        self.0.store(unix_seconds, Ordering::SeqCst);
    }
}

impl Clock for FixedClock {
    fn unix_seconds(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DepositBatch {
    pub payments: Vec<ObservedPayment>,
    pub cursor: Option<LedgerCursor>,
}

#[async_trait]
pub trait DepositSource: Send + Sync {
    async fn verify_network(&self) -> Result<(), ExternalError>;

    async fn payments_after(
        &self,
        cursor: Option<LedgerCursor>,
    ) -> Result<DepositBatch, ExternalError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutIntent {
    quote_id: QuoteReference,
    payment: Sep7Payment,
}

impl PayoutIntent {
    #[must_use]
    pub const fn quote_id(&self) -> &QuoteReference {
        &self.quote_id
    }

    #[must_use]
    pub const fn payment(&self) -> &Sep7Payment {
        &self.payment
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PreparedPayout {
    transaction_hash: TransactionHash,
    signed_envelope: String,
}

impl PreparedPayout {
    /// Creates an externally prepared payout that can be persisted before dispatch.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction hash is invalid.
    pub fn new(
        transaction_hash: impl Into<String>,
        signed_envelope: impl Into<String>,
    ) -> Result<Self, crate::ValueError> {
        let signed_envelope = signed_envelope.into();
        if signed_envelope.trim().is_empty() {
            return Err(crate::ValueError::Empty("signed envelope"));
        }
        Ok(Self {
            transaction_hash: TransactionHash::new(transaction_hash.into())?,
            signed_envelope,
        })
    }

    #[must_use]
    pub const fn transaction_hash(&self) -> &TransactionHash {
        &self.transaction_hash
    }

    #[must_use]
    pub fn signed_envelope(&self) -> &str {
        &self.signed_envelope
    }
}

impl Debug for PreparedPayout {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedPayout")
            .field("transaction_hash", &self.transaction_hash)
            .field("signed_envelope", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayoutObservation {
    NotFound,
    Pending {
        transaction_hash: TransactionHash,
    },
    Confirmed {
        transaction_hash: TransactionHash,
    },
    ProvablyFailed {
        transaction_hash: TransactionHash,
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmitResult {
    Accepted,
    Confirmed,
    ProvablyRejected { reason: String },
    Ambiguous { reason: String },
}

#[async_trait]
pub trait PayoutRail: Send + Sync {
    async fn prepare(&self, intent: &PayoutIntent) -> Result<PreparedPayout, ExternalError>;

    async fn observe(
        &self,
        transaction_hash: &TransactionHash,
    ) -> Result<PayoutObservation, ExternalError>;

    async fn submit(&self, payout: &PreparedPayout) -> Result<SubmitResult, ExternalError>;
}

pub struct StellarPaymentProcessor {
    profile: Arc<StellarProfile>,
    store: Arc<StateStore>,
    deposits: Arc<dyn DepositSource>,
    payouts: Arc<dyn PayoutRail>,
    clock: Arc<dyn Clock>,
    event_stream_active: AtomicBool,
    event_cancel: watch::Sender<bool>,
}

impl Debug for StellarPaymentProcessor {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StellarPaymentProcessor")
            .field("profile", &self.profile)
            .field("store", &self.store)
            .field(
                "event_stream_active",
                &self.event_stream_active.load(Ordering::SeqCst),
            )
            .finish_non_exhaustive()
    }
}

impl StellarPaymentProcessor {
    #[must_use]
    pub fn new(
        profile: Arc<StellarProfile>,
        store: Arc<StateStore>,
        deposits: Arc<dyn DepositSource>,
        payouts: Arc<dyn PayoutRail>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let (event_cancel, _) = watch::channel(false);
        Self {
            profile,
            store,
            deposits,
            payouts,
            clock,
            event_stream_active: AtomicBool::new(false),
            event_cancel,
        }
    }

    #[must_use]
    pub const fn profile(&self) -> &Arc<StellarProfile> {
        &self.profile
    }

    #[must_use]
    pub const fn store(&self) -> &Arc<StateStore> {
        &self.store
    }

    async fn scan_deposits(&self) -> Result<(), CdkPaymentError> {
        let cursor = self.store.snapshot().map_err(cdk_error)?.paging_cursor();
        let batch = self
            .deposits
            .payments_after(cursor)
            .await
            .map_err(cdk_error)?;
        for payment in &batch.payments {
            self.store
                .observe_payment(&self.profile, payment)
                .map_err(cdk_error)?;
        }
        if let Some(cursor) = batch.cursor {
            self.store.advance_cursor(cursor).map_err(cdk_error)?;
        }
        Ok(())
    }

    async fn drive_settlement(
        &self,
        quote_id: &QuoteReference,
    ) -> Result<MakePaymentResponse, CdkPaymentError> {
        let mut quote = self.require_melt_quote(quote_id)?;
        if matches!(quote.settlement().state(), SettlementState::Unpaid) {
            self.store
                .update_settlement(quote_id, Settlement::reserve_proofs)
                .map_err(cdk_error)?;
            quote = self.require_melt_quote(quote_id)?;
        }
        if matches!(
            quote.settlement().state(),
            SettlementState::Paid { .. } | SettlementState::Failed { .. }
        ) {
            return make_response(&quote);
        }
        if matches!(
            quote.settlement().state(),
            SettlementState::Submitted { .. } | SettlementState::NeedsAttention { .. }
        ) {
            self.reconcile_settlement(quote_id).await?;
            return make_response(&self.require_melt_quote(quote_id)?);
        }

        self.prepare_settlement(quote_id, &quote).await?;

        quote = self.require_melt_quote(quote_id)?;
        if matches!(quote.settlement().state(), SettlementState::Failed { .. }) {
            return make_response(&quote);
        }
        let prepared = prepared_payout(quote.settlement())?;
        match self
            .payouts
            .observe(prepared.transaction_hash())
            .await
            .map_err(cdk_error)?
        {
            PayoutObservation::NotFound => {}
            observation => {
                self.apply_observation(quote_id, observation)?;
                return make_response(&self.require_melt_quote(quote_id)?);
            }
        }

        self.dispatch_prepared(quote_id, &prepared).await?;
        make_response(&self.require_melt_quote(quote_id)?)
    }

    async fn prepare_settlement(
        &self,
        quote_id: &QuoteReference,
        quote: &MeltQuoteRecord,
    ) -> Result<(), CdkPaymentError> {
        if quote.settlement().prepared_transaction().is_some() {
            return Ok(());
        }
        let intent = PayoutIntent {
            quote_id: quote_id.clone(),
            payment: quote.payment().clone(),
        };
        match self.payouts.prepare(&intent).await {
            Ok(prepared) => self
                .store
                .update_settlement(quote_id, |settlement| {
                    settlement.record_prepared_transaction(
                        prepared.transaction_hash().as_str(),
                        prepared.signed_envelope(),
                    )
                })
                .map_err(cdk_error),
            Err(_) => self
                .store
                .update_settlement(quote_id, |settlement| {
                    settlement.record_provable_failure("payout preparation failed")
                })
                .map_err(cdk_error),
        }
    }

    async fn dispatch_prepared(
        &self,
        quote_id: &QuoteReference,
        prepared: &PreparedPayout,
    ) -> Result<(), CdkPaymentError> {
        self.store
            .update_settlement(quote_id, Settlement::record_dispatch_started)
            .map_err(cdk_error)?;
        match self.payouts.submit(prepared).await {
            Ok(SubmitResult::Accepted) => {
                self.store
                    .update_settlement(quote_id, |settlement| {
                        settlement.record_submission(prepared.transaction_hash().as_str())
                    })
                    .map_err(cdk_error)?;
            }
            Ok(SubmitResult::Confirmed) => {
                self.store
                    .update_settlement(quote_id, |settlement| {
                        settlement.record_submission(prepared.transaction_hash().as_str())?;
                        settlement.confirm_paid(prepared.transaction_hash().as_str())
                    })
                    .map_err(cdk_error)?;
            }
            Ok(SubmitResult::ProvablyRejected { reason }) => {
                self.store
                    .update_settlement(quote_id, |settlement| {
                        settlement.record_dispatch_rejected(reason)
                    })
                    .map_err(cdk_error)?;
            }
            Ok(SubmitResult::Ambiguous { reason }) => {
                self.store
                    .update_settlement(quote_id, |settlement| settlement.require_attention(reason))
                    .map_err(cdk_error)?;
            }
            Err(error) => {
                self.store
                    .update_settlement(quote_id, |settlement| {
                        settlement.require_attention("payout submission outcome is unknown")
                    })
                    .map_err(cdk_error)?;
                return Err(cdk_error(error));
            }
        }
        Ok(())
    }

    async fn reconcile_settlement(&self, quote_id: &QuoteReference) -> Result<(), CdkPaymentError> {
        let quote = self.require_melt_quote(quote_id)?;
        let Some(prepared) = quote.settlement().prepared_transaction() else {
            return Err(CdkPaymentError::Custom(
                "pending settlement has no durable transaction intent".to_owned(),
            ));
        };
        let observation = self
            .payouts
            .observe(prepared.transaction_hash())
            .await
            .map_err(cdk_error)?;
        if !matches!(observation, PayoutObservation::NotFound) {
            self.apply_observation(quote_id, observation)?;
        }
        Ok(())
    }

    fn apply_observation(
        &self,
        quote_id: &QuoteReference,
        observation: PayoutObservation,
    ) -> Result<(), CdkPaymentError> {
        match observation {
            PayoutObservation::NotFound => Ok(()),
            PayoutObservation::Pending { transaction_hash } => self
                .store
                .update_settlement(quote_id, |settlement| {
                    if matches!(settlement.state(), SettlementState::ProofsReserved) {
                        settlement.record_dispatch_started()?;
                    }
                    settlement.record_submission(transaction_hash.as_str())
                })
                .map_err(cdk_error),
            PayoutObservation::Confirmed { transaction_hash } => self
                .store
                .update_settlement(quote_id, |settlement| {
                    if matches!(settlement.state(), SettlementState::ProofsReserved) {
                        settlement.record_dispatch_started()?;
                        settlement.record_submission(transaction_hash.as_str())?;
                    } else if matches!(settlement.state(), SettlementState::NeedsAttention { .. }) {
                        settlement.record_submission(transaction_hash.as_str())?;
                    }
                    settlement.confirm_paid(transaction_hash.as_str())
                })
                .map_err(cdk_error),
            PayoutObservation::ProvablyFailed {
                transaction_hash,
                reason,
            } => self
                .store
                .update_settlement(quote_id, |settlement| {
                    settlement.record_observed_failure(transaction_hash.as_str(), reason)
                })
                .map_err(cdk_error),
        }
    }

    fn require_melt_quote(
        &self,
        quote_id: &QuoteReference,
    ) -> Result<MeltQuoteRecord, CdkPaymentError> {
        self.store
            .melt_quote(quote_id)
            .map_err(cdk_error)?
            .ok_or_else(|| CdkPaymentError::Custom(format!("unknown melt quote {quote_id}")))
    }
}

#[async_trait]
impl MintPayment for StellarPaymentProcessor {
    type Err = CdkPaymentError;

    async fn start(&self) -> Result<(), Self::Err> {
        self.deposits.verify_network().await.map_err(cdk_error)
    }

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        let settings = json!({
            "asset_code": self.profile.asset().code(),
            "asset_issuer": self.profile.asset().issuer().as_str(),
            "max_amount": self.profile.max_amount().value(),
            "min_amount": self.profile.min_amount().value(),
            "minor_unit_scale": 2,
            "network_id": self.profile.network().network_id(),
            "network_passphrase": self.profile.network().passphrase(),
            "nut20_required": true,
        });
        Ok(SettingsResponse {
            unit: "usdc".to_owned(),
            bolt11: None,
            bolt12: None,
            onchain: None,
            custom: HashMap::from([("stellar".to_owned(), settings.to_string())]),
        })
    }

    async fn create_incoming_payment_request(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Self::Err> {
        let IncomingPaymentOptions::Custom(options) = options else {
            return Err(CdkPaymentError::UnsupportedPaymentOption);
        };
        validate_method(&options.method)?;
        let amount = options
            .amount
            .as_ref()
            .ok_or(CdkPaymentError::AmountMismatch)
            .and_then(cdk_amount)?;
        self.profile.validate_amount(amount).map_err(cdk_error)?;
        let locked_pubkey = options
            .pubkey
            .as_ref()
            .map(ToString::to_string)
            .ok_or_else(|| {
                CdkPaymentError::Custom(
                    "stellar mint quotes require a NUT-20 locking pubkey".to_owned(),
                )
            })?;
        let now = self.clock.unix_seconds();
        let maximum_expiry = now
            .checked_add(self.profile.quote_ttl_seconds())
            .ok_or(CdkPaymentError::InvalidExpiry)?;
        let expiry = options.unix_expiry.unwrap_or(maximum_expiry);
        if expiry <= now || expiry > maximum_expiry {
            return Err(CdkPaymentError::InvalidExpiry);
        }
        let quote_id = quote_reference(&options.quote_id)?;
        let payment = build_deposit_request(&self.profile, &quote_id, amount).map_err(cdk_error)?;
        let correlation_memo = payment.memo().ok_or_else(|| {
            CdkPaymentError::Custom("deposit request is missing its correlation memo".to_owned())
        })?;
        let quote = MintQuoteRecord::new(quote_id, amount, expiry, correlation_memo, locked_pubkey)
            .map_err(cdk_error)?;
        self.store.insert_mint_quote(quote).map_err(cdk_error)?;
        Ok(CreateIncomingPaymentResponse {
            request_lookup_id: PaymentIdentifier::QuoteId(options.quote_id.clone()),
            request: payment.to_uri(),
            expiry: Some(expiry),
            extra_json: Some(json!({
                "asset_code": self.profile.asset().code(),
                "asset_issuer": self.profile.asset().issuer().as_str(),
                "network_id": self.profile.network().network_id(),
            })),
        })
    }

    async fn get_payment_quote(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        validate_unit(unit)?;
        let OutgoingPaymentOptions::Custom(options) = options else {
            return Err(CdkPaymentError::UnsupportedPaymentOption);
        };
        validate_method(&options.method)?;
        let payment = parse_payment_request(&self.profile, &options.request).map_err(cdk_error)?;
        if let Some(amount) = &options.amount
            && cdk_amount(amount)? != payment.amount()
        {
            return Err(CdkPaymentError::AmountMismatch);
        }
        let quote_id = quote_reference(&options.quote_id)?;
        let quote = MeltQuoteRecord::new(quote_id.clone(), payment.clone()).map_err(cdk_error)?;
        self.store.insert_melt_quote(quote).map_err(cdk_error)?;
        let durable_quote = self.require_melt_quote(&quote_id)?;
        let state = durable_quote.settlement().state();
        Ok(PaymentQuoteResponse {
            request_lookup_id: Some(PaymentIdentifier::QuoteId(options.quote_id)),
            amount: typed_amount(payment.amount()),
            fee: zero_amount(),
            state: cdk_melt_state(state),
            extra_json: Some(json!({
                "asset_code": self.profile.asset().code(),
                "asset_issuer": self.profile.asset().issuer().as_str(),
                "network_id": self.profile.network().network_id(),
            })),
            estimated_blocks: None,
            fee_options: None,
        })
    }

    async fn make_payment(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        validate_unit(unit)?;
        let OutgoingPaymentOptions::Custom(options) = options else {
            return Err(CdkPaymentError::UnsupportedPaymentOption);
        };
        validate_method(&options.method)?;
        let quote_id = quote_reference(&options.quote_id)?;
        let requested =
            parse_payment_request(&self.profile, &options.request).map_err(cdk_error)?;
        let stored = self.require_melt_quote(&quote_id)?;
        if stored.payment() != &requested {
            return Err(CdkPaymentError::AmountMismatch);
        }
        if let Some(amount) = &options.amount
            && cdk_amount(amount)? != stored.payment().amount()
        {
            return Err(CdkPaymentError::AmountMismatch);
        }
        self.drive_settlement(&quote_id).await
    }

    async fn wait_payment_event(
        &self,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, Self::Err> {
        self.event_cancel.send_replace(false);
        self.event_stream_active.store(true, Ordering::SeqCst);
        let receiver = self.event_cancel.subscribe();
        let event_stream = stream::unfold(receiver, |mut receiver| async move {
            if *receiver.borrow() {
                return None;
            }
            let _ = receiver.changed().await;
            None::<(Event, watch::Receiver<bool>)>
        });
        Ok(Box::pin(event_stream))
    }

    fn is_payment_event_stream_active(&self) -> bool {
        self.event_stream_active.load(Ordering::SeqCst)
    }

    fn cancel_payment_event_stream(&self) {
        self.event_stream_active.store(false, Ordering::SeqCst);
        self.event_cancel.send_replace(true);
    }

    async fn check_incoming_payment_status(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        let quote_id = payment_quote_reference(payment_identifier)?;
        let Some(quote) = self.store.mint_quote(&quote_id).map_err(cdk_error)? else {
            return Ok(Vec::new());
        };
        if quote.claim().is_none() {
            self.scan_deposits().await?;
        }
        let Some(quote) = self.store.mint_quote(&quote_id).map_err(cdk_error)? else {
            return Ok(Vec::new());
        };
        let Some(claim) = quote.claim() else {
            return Ok(Vec::new());
        };
        Ok(vec![WaitPaymentResponse {
            payment_identifier: PaymentIdentifier::QuoteId(cdk_quote_id(&quote_id)?),
            payment_amount: typed_amount(quote.amount()),
            payment_id: claim.operation_id().to_string(),
        }])
    }

    async fn check_outgoing_payment(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        let quote_id = payment_quote_reference(payment_identifier)?;
        let quote = self.require_melt_quote(&quote_id)?;
        if matches!(
            quote.settlement().state(),
            SettlementState::ProofsReserved
                | SettlementState::Submitted { .. }
                | SettlementState::NeedsAttention { .. }
        ) && quote.settlement().prepared_transaction().is_some()
        {
            self.reconcile_settlement(&quote_id).await?;
        }
        make_response(&self.require_melt_quote(&quote_id)?)
    }
}

fn validate_method(method: &str) -> Result<(), CdkPaymentError> {
    if method.is_empty() || method == "stellar" {
        Ok(())
    } else {
        Err(CdkPaymentError::UnsupportedPaymentOption)
    }
}

fn validate_unit(unit: &CurrencyUnit) -> Result<(), CdkPaymentError> {
    if unit == &CurrencyUnit::custom("usdc") {
        Ok(())
    } else {
        Err(CdkPaymentError::UnsupportedUnit)
    }
}

fn cdk_amount(amount: &Amount<CurrencyUnit>) -> Result<UsdcMinorUnits, CdkPaymentError> {
    validate_unit(amount.unit())?;
    UsdcMinorUnits::new(amount.value()).map_err(cdk_error)
}

fn quote_reference(quote_id: &QuoteId) -> Result<QuoteReference, CdkPaymentError> {
    QuoteReference::new(quote_id.to_string()).map_err(cdk_error)
}

fn payment_quote_reference(
    identifier: &PaymentIdentifier,
) -> Result<QuoteReference, CdkPaymentError> {
    let PaymentIdentifier::QuoteId(quote_id) = identifier else {
        return Err(CdkPaymentError::UnsupportedPaymentOption);
    };
    quote_reference(quote_id)
}

fn cdk_quote_id(quote_id: &QuoteReference) -> Result<QuoteId, CdkPaymentError> {
    QuoteId::from_str(quote_id.as_str())
        .map_err(|_| CdkPaymentError::Custom("invalid durable quote id".to_owned()))
}

fn typed_amount(amount: UsdcMinorUnits) -> Amount<CurrencyUnit> {
    Amount::new(amount.value(), CurrencyUnit::custom("usdc"))
}

fn zero_amount() -> Amount<CurrencyUnit> {
    Amount::new(0, CurrencyUnit::custom("usdc"))
}

fn prepared_payout(settlement: &Settlement) -> Result<PreparedPayout, CdkPaymentError> {
    let prepared = settlement.prepared_transaction().ok_or_else(|| {
        CdkPaymentError::Custom("settlement has no durable prepared transaction".to_owned())
    })?;
    PreparedPayout::new(
        prepared.transaction_hash().as_str(),
        prepared.signed_envelope(),
    )
    .map_err(cdk_error)
}

fn make_response(quote: &MeltQuoteRecord) -> Result<MakePaymentResponse, CdkPaymentError> {
    let (payment_proof, total_spent) = match quote.settlement().state() {
        SettlementState::Unpaid
        | SettlementState::ProofsReserved
        | SettlementState::Submitted { .. }
        | SettlementState::NeedsAttention { .. }
        | SettlementState::Failed { .. } => (None, zero_amount()),
        SettlementState::Paid { transaction_hash } => (
            Some(transaction_hash.to_string()),
            typed_amount(quote.payment().amount()),
        ),
    };
    Ok(MakePaymentResponse {
        payment_lookup_id: PaymentIdentifier::QuoteId(cdk_quote_id(quote.quote_id())?),
        payment_proof,
        status: cdk_melt_state(quote.settlement().state()),
        total_spent,
    })
}

const fn cdk_melt_state(state: &SettlementState) -> MeltQuoteState {
    match state {
        SettlementState::Unpaid => MeltQuoteState::Unpaid,
        SettlementState::ProofsReserved | SettlementState::Submitted { .. } => {
            MeltQuoteState::Pending
        }
        SettlementState::NeedsAttention { .. } => MeltQuoteState::Unknown,
        SettlementState::Paid { .. } => MeltQuoteState::Paid,
        SettlementState::Failed { .. } => MeltQuoteState::Failed,
    }
}

fn cdk_error(error: impl std::fmt::Display) -> CdkPaymentError {
    CdkPaymentError::Custom(error.to_string())
}
