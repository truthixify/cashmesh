use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cashmesh_stellar_settlement::{
    CIRCLE_TESTNET_USDC_ISSUER, DepositBatch, DepositRejection, DepositSource, ExternalError,
    FixedClock, HorizonDepositSource, LedgerCursor, MintQuoteRecord, ObservationOutcome,
    ObservedPayment, PaymentOperationId, PayoutIntent, PayoutObservation, PayoutRail,
    PreparedPayout, QuoteReference, STELLAR_TESTNET_NETWORK_ID, STELLAR_TESTNET_PASSPHRASE,
    StateStore, StellarPaymentProcessor, StellarProfile, SubmitResult, TransactionHash,
    UsdcMinorUnits, build_deposit_request, normalize_horizon_payment,
};
use cdk_common::payment::{
    CustomIncomingPaymentOptions, CustomOutgoingPaymentOptions, Error as CdkPaymentError,
    IncomingPaymentOptions, MintPayment, OutgoingPaymentOptions, PaymentIdentifier,
};
use cdk_common::{Amount, CurrencyUnit, MeltQuoteState, PublicKey, QuoteId};
use cdk_payment_processor::PaymentProcessorServer;
use stellar_horizon::resources::Payment;
use tempfile::TempDir;

const DESTINATION: &str = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const OTHER_ACCOUNT: &str = "GCEE2MAVLB3D5J64TTHR3T4ZYK4BZJEYIPE7FMG4NAXHY3VQRHW55BNX";
const MINT_QUOTE: &str = "550e8400-e29b-41d4-a716-446655440000";
const MELT_QUOTE: &str = "650e8400-e29b-41d4-a716-446655440000";
const SECOND_QUOTE: &str = "750e8400-e29b-41d4-a716-446655440000";
const LOCKING_PUBKEY: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PAYOUT_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MUXED_DESTINATION: &str =
    "MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU";
const FIXED_NOW: u64 = 1_893_455_400;
const FIXED_EXPIRY: u64 = 1_893_456_300;

#[derive(Debug, Default)]
struct FixtureDepositSource {
    payments: Mutex<Vec<ObservedPayment>>,
}

impl FixtureDepositSource {
    fn new(payments: Vec<ObservedPayment>) -> Self {
        Self {
            payments: Mutex::new(payments),
        }
    }
}

#[async_trait]
impl DepositSource for FixtureDepositSource {
    async fn verify_network(&self) -> Result<(), ExternalError> {
        Ok(())
    }

    async fn payments_after(
        &self,
        cursor: Option<LedgerCursor>,
    ) -> Result<DepositBatch, ExternalError> {
        let payments = self
            .payments
            .lock()
            .expect("fixture deposit source lock")
            .iter()
            .filter(|payment| cursor.is_none_or(|cursor| payment.paging_cursor > cursor))
            .cloned()
            .collect::<Vec<_>>();
        let cursor = payments.iter().map(|payment| payment.paging_cursor).max();
        Ok(DepositBatch { payments, cursor })
    }
}

#[derive(Debug)]
struct FixturePayoutRail {
    state: Mutex<FixturePayoutState>,
}

#[derive(Debug)]
struct FixturePayoutState {
    next_result: SubmitResult,
    effect_on_ambiguous: bool,
    observations: BTreeMap<TransactionHash, PayoutObservation>,
    submit_count: usize,
}

impl FixturePayoutRail {
    fn new(next_result: SubmitResult) -> Self {
        Self {
            state: Mutex::new(FixturePayoutState {
                next_result,
                effect_on_ambiguous: false,
                observations: BTreeMap::new(),
                submit_count: 0,
            }),
        }
    }

    fn ambiguous_with_effect() -> Self {
        let rail = Self::new(SubmitResult::Ambiguous {
            reason: "fixture response lost after acceptance".to_owned(),
        });
        rail.state
            .lock()
            .expect("fixture payout lock")
            .effect_on_ambiguous = true;
        rail
    }

    fn confirm(&self) {
        let hash = TransactionHash::new(PAYOUT_HASH).expect("fixture transaction hash");
        self.state
            .lock()
            .expect("fixture payout lock")
            .observations
            .insert(
                hash.clone(),
                PayoutObservation::Confirmed {
                    transaction_hash: hash,
                },
            );
    }

    fn submit_count(&self) -> usize {
        self.state.lock().expect("fixture payout lock").submit_count
    }
}

#[async_trait]
impl PayoutRail for FixturePayoutRail {
    async fn prepare(&self, intent: &PayoutIntent) -> Result<PreparedPayout, ExternalError> {
        assert!(!intent.quote_id().as_str().is_empty());
        assert_eq!(intent.payment().asset_code(), "USDC");
        PreparedPayout::new(PAYOUT_HASH, "fixture-signed-envelope")
            .map_err(|error| Box::new(error) as ExternalError)
    }

    async fn observe(
        &self,
        transaction_hash: &TransactionHash,
    ) -> Result<PayoutObservation, ExternalError> {
        Ok(self
            .state
            .lock()
            .expect("fixture payout lock")
            .observations
            .get(transaction_hash)
            .cloned()
            .unwrap_or(PayoutObservation::NotFound))
    }

    async fn submit(&self, payout: &PreparedPayout) -> Result<SubmitResult, ExternalError> {
        let mut state = self.state.lock().expect("fixture payout lock");
        state.submit_count += 1;
        let result = state.next_result.clone();
        let observation = match &result {
            SubmitResult::Accepted => Some(PayoutObservation::Pending {
                transaction_hash: payout.transaction_hash().clone(),
            }),
            SubmitResult::Confirmed => Some(PayoutObservation::Confirmed {
                transaction_hash: payout.transaction_hash().clone(),
            }),
            SubmitResult::Ambiguous { .. } if state.effect_on_ambiguous => {
                Some(PayoutObservation::Confirmed {
                    transaction_hash: payout.transaction_hash().clone(),
                })
            }
            SubmitResult::ProvablyRejected { .. } | SubmitResult::Ambiguous { .. } => None,
        };
        if let Some(observation) = observation {
            state
                .observations
                .insert(payout.transaction_hash().clone(), observation);
        }
        Ok(result)
    }
}

struct Harness {
    _directory: TempDir,
    state_path: std::path::PathBuf,
    profile: Arc<StellarProfile>,
    deposits: Arc<FixtureDepositSource>,
    payouts: Arc<FixturePayoutRail>,
    processor: Arc<StellarPaymentProcessor>,
}

impl Harness {
    fn new(payments: Vec<ObservedPayment>, payout: FixturePayoutRail) -> Self {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("stellar-state.json");
        let profile = Arc::new(StellarProfile::testnet_usdc(DESTINATION).expect("valid profile"));
        let deposits = Arc::new(FixtureDepositSource::new(payments));
        let payouts = Arc::new(payout);
        let processor = Arc::new(StellarPaymentProcessor::new(
            profile.clone(),
            Arc::new(StateStore::open(&state_path).expect("state store opens")),
            deposits.clone(),
            payouts.clone(),
            Arc::new(FixedClock::new(FIXED_NOW)),
        ));
        Self {
            _directory: directory,
            state_path,
            profile,
            deposits,
            payouts,
            processor,
        }
    }

    fn restarted_processor(&self) -> Arc<StellarPaymentProcessor> {
        Arc::new(StellarPaymentProcessor::new(
            self.profile.clone(),
            Arc::new(StateStore::open(&self.state_path).expect("state store reopens")),
            self.deposits.clone(),
            self.payouts.clone(),
            Arc::new(FixedClock::new(FIXED_NOW)),
        ))
    }
}

fn custom_unit() -> CurrencyUnit {
    CurrencyUnit::custom("usdc")
}

fn quote_id(value: &str) -> QuoteId {
    QuoteId::from_str(value).expect("fixture quote id")
}

fn incoming_options(method: &str, with_pubkey: bool) -> IncomingPaymentOptions {
    IncomingPaymentOptions::Custom(Box::new(CustomIncomingPaymentOptions {
        method: method.to_owned(),
        description: None,
        amount: Some(Amount::new(1_234, custom_unit())),
        unix_expiry: Some(FIXED_EXPIRY),
        extra_json: None,
        quote_id: quote_id(MINT_QUOTE),
        pubkey: with_pubkey.then(|| PublicKey::from_str(LOCKING_PUBKEY).expect("fixture pubkey")),
    }))
}

fn payout_request(profile: &StellarProfile) -> String {
    build_deposit_request(
        profile,
        &QuoteReference::new("payout-request").expect("fixture request id"),
        UsdcMinorUnits::new(1_234).expect("positive amount"),
    )
    .expect("payout request builds")
    .to_uri()
}

fn outgoing_options(profile: &StellarProfile) -> OutgoingPaymentOptions {
    OutgoingPaymentOptions::Custom(Box::new(CustomOutgoingPaymentOptions {
        method: "stellar".to_owned(),
        request: payout_request(profile),
        amount: Some(Amount::new(1_234, custom_unit())),
        max_fee_amount: Some(Amount::new(0, custom_unit())),
        timeout_secs: None,
        melt_options: None,
        extra_json: None,
        quote_id: quote_id(MELT_QUOTE),
    }))
}

fn horizon_payment() -> ObservedPayment {
    let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
    let payment: Payment =
        serde_json::from_str(include_str!("../fixtures/horizon/payment-usdc.json"))
            .expect("Horizon fixture parses through pinned client types");
    normalize_horizon_payment(&profile, &payment)
        .expect("Horizon payment normalizes")
        .expect("fixture is a direct credit payment")
}

async fn create_melt_quote(processor: &StellarPaymentProcessor, profile: &StellarProfile) {
    processor
        .get_payment_quote(&custom_unit(), outgoing_options(profile))
        .await
        .expect("melt quote is created");
}

#[tokio::test]
async fn stock_cdk_grpc_boundary_accepts_blank_custom_method() {
    let harness = Harness::new(Vec::new(), FixturePayoutRail::new(SubmitResult::Accepted));
    let backend: Arc<dyn MintPayment<Err = CdkPaymentError> + Send + Sync> =
        harness.processor.clone();
    PaymentProcessorServer::new(backend, "127.0.0.1", 0)
        .expect("stock CDK gRPC server accepts the backend");

    let settings = harness
        .processor
        .get_settings()
        .await
        .expect("settings are available");
    assert_eq!(settings.unit, "usdc");
    assert!(settings.custom.contains_key("stellar"));

    let response = harness
        .processor
        .create_incoming_payment_request(incoming_options("", true))
        .await
        .expect("rc.3 blank gRPC custom method is treated as stellar");
    assert_eq!(
        response.request,
        include_str!("../fixtures/sep7/mint-quote.txt").trim()
    );
    assert_eq!(response.expiry, Some(FIXED_EXPIRY));
}

#[tokio::test]
async fn mint_quote_requires_nut20_locking_key() {
    let harness = Harness::new(Vec::new(), FixturePayoutRail::new(SubmitResult::Accepted));
    assert!(
        harness
            .processor
            .create_incoming_payment_request(incoming_options("stellar", false))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mint_quote_rejects_expiry_beyond_profile_ttl() {
    let harness = Harness::new(Vec::new(), FixturePayoutRail::new(SubmitResult::Accepted));
    let IncomingPaymentOptions::Custom(mut options) = incoming_options("stellar", true) else {
        unreachable!("fixture always returns custom options");
    };
    options.unix_expiry = Some(FIXED_EXPIRY + 1);
    assert!(
        harness
            .processor
            .create_incoming_payment_request(IncomingPaymentOptions::Custom(options))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn finalized_exact_payment_claims_one_quote_across_restart() {
    let harness = Harness::new(
        vec![horizon_payment()],
        FixturePayoutRail::new(SubmitResult::Accepted),
    );
    harness
        .processor
        .create_incoming_payment_request(incoming_options("stellar", true))
        .await
        .expect("mint quote is created");
    let identifier = PaymentIdentifier::QuoteId(quote_id(MINT_QUOTE));

    let first = harness
        .processor
        .check_incoming_payment_status(&identifier)
        .await
        .expect("deposit scan succeeds");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].payment_id, "123456789");

    let restarted = harness.restarted_processor();
    let recovered = restarted
        .check_incoming_payment_status(&identifier)
        .await
        .expect("durable claim survives restart");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].payment_id, first[0].payment_id);
    assert_eq!(
        restarted
            .store()
            .snapshot()
            .expect("state snapshot")
            .paging_cursor(),
        Some(LedgerCursor::new("123456789").expect("fixture cursor"))
    );
}

#[test]
fn deposit_validation_rejects_wrong_network_asset_issuer_amount_and_expiry() {
    assert_eq!(
        reject_variant(FIXED_EXPIRY, |payment| {
            payment.network_passphrase =
                "Public Global Stellar Network ; September 2015".to_owned();
            payment.network_id = "0".repeat(64);
        }),
        DepositRejection::WrongNetwork
    );
    assert_eq!(
        reject_variant(FIXED_EXPIRY, |payment| {
            payment.asset_code = "EURC".to_owned();
        }),
        DepositRejection::WrongAssetCode
    );
    assert_eq!(
        reject_variant(FIXED_EXPIRY, |payment| {
            payment.asset_issuer =
                cashmesh_stellar_settlement::StellarAddress::new_account(OTHER_ACCOUNT)
                    .expect("valid alternate issuer");
        }),
        DepositRejection::WrongAssetIssuer
    );
    assert_eq!(
        reject_variant(FIXED_EXPIRY, |payment| {
            payment.amount = "12.3500000".to_owned();
        }),
        DepositRejection::WrongAmount
    );
    assert_eq!(
        reject_variant(1_893_455_999, |_| {}),
        DepositRejection::Expired
    );
}

#[test]
fn horizon_normalizer_cross_checks_transaction_hash_and_muxed_destination() {
    let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
    let mut mismatched: Payment =
        serde_json::from_str(include_str!("../fixtures/horizon/payment-usdc.json"))
            .expect("fixture parses");
    let Payment::Payment(operation) = &mut mismatched else {
        unreachable!("fixture is a direct payment");
    };
    operation
        .base
        .transaction
        .as_mut()
        .expect("joined transaction")
        .hash = "c".repeat(64);
    assert!(normalize_horizon_payment(&profile, &mismatched).is_err());

    let mut muxed: Payment =
        serde_json::from_str(include_str!("../fixtures/horizon/payment-usdc.json"))
            .expect("fixture parses");
    let Payment::Payment(operation) = &mut muxed else {
        unreachable!("fixture is a direct payment");
    };
    operation.to_muxed = Some(MUXED_DESTINATION.to_owned());
    let normalized = normalize_horizon_payment(&profile, &muxed)
        .expect("payment normalizes")
        .expect("direct payment");
    assert_eq!(normalized.destination.as_str(), MUXED_DESTINATION);
}

#[test]
fn deposit_claim_rejects_operation_and_transaction_replay() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = StateStore::open(directory.path().join("state.json")).expect("store opens");
    let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
    let first_id = QuoteReference::new(MINT_QUOTE).expect("quote id");
    insert_quote(&store, &profile, first_id.clone(), FIXED_EXPIRY);
    let payment = horizon_payment();
    assert!(matches!(
        store
            .observe_payment(&profile, &payment)
            .expect("observation persists"),
        ObservationOutcome::Claimed { .. }
    ));

    let second_id = QuoteReference::new(SECOND_QUOTE).expect("quote id");
    let second_request = insert_quote(&store, &profile, second_id, FIXED_EXPIRY);
    let mut replayed_operation = payment.clone();
    replayed_operation.paging_cursor = LedgerCursor::new("123456790").expect("cursor");
    replayed_operation.memo = second_request.memo().map(str::to_owned);
    assert_eq!(
        store
            .observe_payment(&profile, &replayed_operation)
            .expect("replay is classified"),
        ObservationOutcome::Rejected(DepositRejection::ReplayedOperation(first_id.clone()))
    );

    let mut replayed_transaction = replayed_operation;
    replayed_transaction.paging_cursor = LedgerCursor::new("123456791").expect("cursor");
    replayed_transaction.operation_id = PaymentOperationId::new("123456791").expect("operation id");
    assert_eq!(
        store
            .observe_payment(&profile, &replayed_transaction)
            .expect("replay is classified"),
        ObservationOutcome::Rejected(DepositRejection::ReplayedTransaction(first_id))
    );
}

#[tokio::test]
async fn payout_is_submitted_once_then_confirmed_by_observation() {
    let harness = Harness::new(Vec::new(), FixturePayoutRail::new(SubmitResult::Accepted));
    create_melt_quote(&harness.processor, &harness.profile).await;
    let options = outgoing_options(&harness.profile);
    let pending = harness
        .processor
        .make_payment(&custom_unit(), options.clone())
        .await
        .expect("payout submission succeeds");
    assert_eq!(pending.status, MeltQuoteState::Pending);
    assert_eq!(harness.payouts.submit_count(), 1);

    harness.payouts.confirm();
    let paid = harness
        .processor
        .check_outgoing_payment(&PaymentIdentifier::QuoteId(quote_id(MELT_QUOTE)))
        .await
        .expect("payout reconciliation succeeds");
    assert_eq!(paid.status, MeltQuoteState::Paid);
    assert_eq!(paid.total_spent.value(), 1_234);

    let repeated = harness
        .processor
        .make_payment(&custom_unit(), options)
        .await
        .expect("paid settlement is idempotent");
    assert_eq!(repeated.status, MeltQuoteState::Paid);
    assert_eq!(harness.payouts.submit_count(), 1);
}

#[tokio::test]
async fn ambiguous_submission_recovers_after_restart_without_second_payout() {
    let harness = Harness::new(Vec::new(), FixturePayoutRail::ambiguous_with_effect());
    create_melt_quote(&harness.processor, &harness.profile).await;
    let options = outgoing_options(&harness.profile);
    let ambiguous = harness
        .processor
        .make_payment(&custom_unit(), options.clone())
        .await
        .expect("ambiguous outcome is represented conservatively");
    assert_eq!(ambiguous.status, MeltQuoteState::Unknown);
    assert_eq!(harness.payouts.submit_count(), 1);

    let recovered = harness
        .restarted_processor()
        .make_payment(&custom_unit(), options)
        .await
        .expect("restart observes the existing transaction");
    assert_eq!(recovered.status, MeltQuoteState::Paid);
    assert_eq!(harness.payouts.submit_count(), 1);
}

#[tokio::test]
async fn terminal_rejection_fails_but_unobserved_ambiguity_keeps_proofs_reserved() {
    let rejected = Harness::new(
        Vec::new(),
        FixturePayoutRail::new(SubmitResult::ProvablyRejected {
            reason: "fixture envelope rejected before acceptance".to_owned(),
        }),
    );
    create_melt_quote(&rejected.processor, &rejected.profile).await;
    let failed = rejected
        .processor
        .make_payment(&custom_unit(), outgoing_options(&rejected.profile))
        .await
        .expect("provable rejection is terminal");
    assert_eq!(failed.status, MeltQuoteState::Failed);

    let ambiguous = Harness::new(
        Vec::new(),
        FixturePayoutRail::new(SubmitResult::Ambiguous {
            reason: "fixture timeout".to_owned(),
        }),
    );
    create_melt_quote(&ambiguous.processor, &ambiguous.profile).await;
    let options = outgoing_options(&ambiguous.profile);
    let unknown = ambiguous
        .processor
        .make_payment(&custom_unit(), options.clone())
        .await
        .expect("ambiguous outcome is retained");
    assert_eq!(unknown.status, MeltQuoteState::Unknown);
    let retried = ambiguous
        .processor
        .make_payment(&custom_unit(), options)
        .await
        .expect("automatic retry only observes");
    assert_eq!(retried.status, MeltQuoteState::Unknown);
    assert_eq!(ambiguous.payouts.submit_count(), 1);
}

fn reject_variant(expires_at: u64, change: impl FnOnce(&mut ObservedPayment)) -> DepositRejection {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = StateStore::open(directory.path().join("state.json")).expect("store opens");
    let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
    insert_quote(
        &store,
        &profile,
        QuoteReference::new(MINT_QUOTE).expect("quote id"),
        expires_at,
    );
    let mut payment = horizon_payment();
    change(&mut payment);
    let outcome = store
        .observe_payment(&profile, &payment)
        .expect("rejection and cursor persist atomically");
    assert_eq!(
        store.snapshot().expect("snapshot").paging_cursor(),
        Some(payment.paging_cursor)
    );
    let ObservationOutcome::Rejected(rejection) = outcome else {
        panic!("expected rejected payment, got {outcome:?}");
    };
    rejection
}

fn insert_quote(
    store: &StateStore,
    profile: &StellarProfile,
    quote_id: QuoteReference,
    expires_at: u64,
) -> cashmesh_stellar_settlement::Sep7Payment {
    let amount = UsdcMinorUnits::new(1_234).expect("positive amount");
    let request = build_deposit_request(profile, &quote_id, amount).expect("request builds");
    store
        .insert_mint_quote(
            MintQuoteRecord::new(
                quote_id,
                amount,
                expires_at,
                request.memo().expect("deposit memo"),
                LOCKING_PUBKEY,
            )
            .expect("quote record"),
        )
        .expect("quote persists");
    request
}

#[test]
fn pinned_profile_constants_match_fixture_identity() {
    assert_eq!(
        STELLAR_TESTNET_PASSPHRASE,
        "Test SDF Network ; September 2015"
    );
    assert_eq!(
        STELLAR_TESTNET_NETWORK_ID,
        "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472"
    );
    assert_eq!(
        CIRCLE_TESTNET_USDC_ISSUER,
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    );
}

#[tokio::test]
#[ignore = "read-only live Stellar testnet identity check"]
async fn live_horizon_endpoint_reports_the_pinned_testnet_identity() {
    let profile = Arc::new(StellarProfile::testnet_usdc(DESTINATION).expect("valid profile"));
    let source = HorizonDepositSource::new(profile).expect("Horizon source initializes");
    source
        .verify_network()
        .await
        .expect("Horizon root matches the pinned network identity");
}
