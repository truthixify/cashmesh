use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    LedgerCursor, PaymentOperationId, QuoteReference, Sep7Payment, Settlement, SettlementError,
    SettlementId, StellarAddress, StellarProfile, TransactionHash, UsdcMinorUnits, ValueError,
};

const STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ObservedPayment {
    pub network_passphrase: String,
    pub network_id: String,
    pub operation_id: PaymentOperationId,
    pub paging_cursor: LedgerCursor,
    pub transaction_hash: TransactionHash,
    pub ledger_sequence: u32,
    pub transaction_successful: bool,
    pub ledger_closed_at: u64,
    pub destination: StellarAddress,
    pub asset_code: String,
    pub asset_issuer: StellarAddress,
    pub amount: String,
    pub memo: Option<String>,
    pub memo_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DepositClaim {
    operation_id: PaymentOperationId,
    transaction_hash: TransactionHash,
    ledger_sequence: u32,
    ledger_closed_at: u64,
}

impl DepositClaim {
    #[must_use]
    pub const fn operation_id(&self) -> &PaymentOperationId {
        &self.operation_id
    }

    #[must_use]
    pub const fn transaction_hash(&self) -> &TransactionHash {
        &self.transaction_hash
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MintQuoteRecord {
    quote_id: QuoteReference,
    amount: UsdcMinorUnits,
    expires_at: u64,
    correlation_memo: String,
    locked_pubkey: String,
    claim: Option<DepositClaim>,
}

impl MintQuoteRecord {
    /// Creates an unpaid, locked mint quote record.
    ///
    /// # Errors
    ///
    /// Returns an error for a zero expiry or empty correlation and locking values.
    pub fn new(
        quote_id: QuoteReference,
        amount: UsdcMinorUnits,
        expires_at: u64,
        correlation_memo: impl Into<String>,
        locked_pubkey: impl Into<String>,
    ) -> Result<Self, StoreError> {
        let correlation_memo = correlation_memo.into();
        let locked_pubkey = locked_pubkey.into();
        if expires_at == 0 {
            return Err(StoreError::InvalidQuote("expiry must be nonzero"));
        }
        if correlation_memo.trim().is_empty() {
            return Err(StoreError::InvalidQuote("correlation memo cannot be empty"));
        }
        if locked_pubkey.trim().is_empty() {
            return Err(StoreError::InvalidQuote("NUT-20 pubkey cannot be empty"));
        }
        Ok(Self {
            quote_id,
            amount,
            expires_at,
            correlation_memo,
            locked_pubkey,
            claim: None,
        })
    }

    #[must_use]
    pub const fn quote_id(&self) -> &QuoteReference {
        &self.quote_id
    }

    #[must_use]
    pub const fn amount(&self) -> UsdcMinorUnits {
        self.amount
    }

    #[must_use]
    pub const fn expires_at(&self) -> u64 {
        self.expires_at
    }

    #[must_use]
    pub fn correlation_memo(&self) -> &str {
        &self.correlation_memo
    }

    #[must_use]
    pub const fn claim(&self) -> Option<&DepositClaim> {
        self.claim.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MeltQuoteRecord {
    quote_id: QuoteReference,
    payment: Sep7Payment,
    settlement: Settlement,
}

impl MeltQuoteRecord {
    /// Creates an unpaid settlement record for a validated payment request.
    ///
    /// # Errors
    ///
    /// Returns an error when the quote identifier cannot form a settlement identifier.
    pub fn new(quote_id: QuoteReference, payment: Sep7Payment) -> Result<Self, StoreError> {
        let settlement = Settlement::new(SettlementId::new(quote_id.as_str())?);
        Ok(Self {
            quote_id,
            payment,
            settlement,
        })
    }

    #[must_use]
    pub const fn quote_id(&self) -> &QuoteReference {
        &self.quote_id
    }

    #[must_use]
    pub const fn payment(&self) -> &Sep7Payment {
        &self.payment
    }

    #[must_use]
    pub const fn settlement(&self) -> &Settlement {
        &self.settlement
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersistentState {
    version: u32,
    mint_quotes: BTreeMap<QuoteReference, MintQuoteRecord>,
    melt_quotes: BTreeMap<QuoteReference, MeltQuoteRecord>,
    claimed_operations: BTreeMap<PaymentOperationId, QuoteReference>,
    claimed_transactions: BTreeMap<TransactionHash, QuoteReference>,
    paging_cursor: Option<LedgerCursor>,
}

impl Default for PersistentState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            mint_quotes: BTreeMap::new(),
            melt_quotes: BTreeMap::new(),
            claimed_operations: BTreeMap::new(),
            claimed_transactions: BTreeMap::new(),
            paging_cursor: None,
        }
    }
}

impl PersistentState {
    #[must_use]
    pub const fn paging_cursor(&self) -> Option<LedgerCursor> {
        self.paging_cursor
    }

    #[must_use]
    pub fn mint_quote(&self, quote_id: &QuoteReference) -> Option<&MintQuoteRecord> {
        self.mint_quotes.get(quote_id)
    }

    #[must_use]
    pub fn melt_quote(&self, quote_id: &QuoteReference) -> Option<&MeltQuoteRecord> {
        self.melt_quotes.get(quote_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservationOutcome {
    Claimed {
        quote_id: QuoteReference,
        claim: DepositClaim,
    },
    AlreadyClaimed {
        quote_id: QuoteReference,
        claim: DepositClaim,
    },
    Rejected(DepositRejection),
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum DepositRejection {
    #[error("payment cursor is not newer than the durable observer cursor")]
    StaleCursor,
    #[error("payment does not contain a known CashMesh correlation memo")]
    UnknownCorrelation,
    #[error("payment was observed on the wrong Stellar network")]
    WrongNetwork,
    #[error("payment transaction is not successful in a closed ledger")]
    NotFinal,
    #[error("payment reached the wrong destination")]
    WrongDestination,
    #[error("payment uses the wrong asset code")]
    WrongAssetCode,
    #[error("payment uses the wrong asset issuer")]
    WrongAssetIssuer,
    #[error("payment amount is not the exact quoted amount")]
    WrongAmount,
    #[error("payment was included after quote expiry")]
    Expired,
    #[error("payment operation was already claimed by quote {0}")]
    ReplayedOperation(QuoteReference),
    #[error("payment transaction was already claimed by quote {0}")]
    ReplayedTransaction(QuoteReference),
    #[error("quote already has a different payment claim")]
    QuoteAlreadyPaid,
    #[error("invalid observed payment value")]
    InvalidValue,
}

#[derive(Debug)]
pub struct StateStore {
    path: PathBuf,
    state: Mutex<PersistentState>,
}

impl StateStore {
    /// Opens or initializes a versioned JSON state journal.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal cannot be read, decoded, or migrated.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        let state = if path.exists() {
            let bytes = fs::read(&path).map_err(|source| StoreError::Io {
                operation: "read state journal",
                source,
            })?;
            let state: PersistentState = serde_json::from_slice(&bytes)?;
            if state.version != STATE_VERSION {
                return Err(StoreError::UnsupportedStateVersion(state.version));
            }
            state
        } else {
            PersistentState::default()
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    /// Returns a consistent clone of the current durable state.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Poisoned`] if a prior panic poisoned the store lock.
    pub fn snapshot(&self) -> Result<PersistentState, StoreError> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| StoreError::Poisoned)
    }

    /// Persists a mint quote without changing an existing quote definition.
    ///
    /// # Errors
    ///
    /// Returns an error for conflicting ids or correlations and for persistence failures.
    pub fn insert_mint_quote(&self, quote: MintQuoteRecord) -> Result<(), StoreError> {
        self.update(|state| {
            if state.mint_quotes.values().any(|existing| {
                existing.quote_id != quote.quote_id
                    && existing.correlation_memo == quote.correlation_memo
            }) {
                return Err(StoreError::DuplicateCorrelation);
            }
            match state.mint_quotes.get(&quote.quote_id) {
                Some(existing) if existing == &quote => Ok(()),
                Some(_) => Err(StoreError::QuoteConflict(quote.quote_id.clone())),
                None => {
                    state.mint_quotes.insert(quote.quote_id.clone(), quote);
                    Ok(())
                }
            }
        })
    }

    /// Persists a melt quote idempotently by quote id and payment request.
    ///
    /// # Errors
    ///
    /// Returns an error for a conflicting quote or persistence failure.
    pub fn insert_melt_quote(&self, quote: MeltQuoteRecord) -> Result<(), StoreError> {
        self.update(|state| match state.melt_quotes.get(&quote.quote_id) {
            Some(existing) if existing.payment == quote.payment => Ok(()),
            Some(_) => Err(StoreError::QuoteConflict(quote.quote_id.clone())),
            None => {
                state.melt_quotes.insert(quote.quote_id.clone(), quote);
                Ok(())
            }
        })
    }

    /// Reads one mint quote from a consistent snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error if the state lock is poisoned.
    pub fn mint_quote(
        &self,
        quote_id: &QuoteReference,
    ) -> Result<Option<MintQuoteRecord>, StoreError> {
        Ok(self.snapshot()?.mint_quotes.get(quote_id).cloned())
    }

    /// Reads one melt quote from a consistent snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error if the state lock is poisoned.
    pub fn melt_quote(
        &self,
        quote_id: &QuoteReference,
    ) -> Result<Option<MeltQuoteRecord>, StoreError> {
        Ok(self.snapshot()?.melt_quotes.get(quote_id).cloned())
    }

    /// Applies and persists one settlement transition atomically.
    ///
    /// # Errors
    ///
    /// Returns an error for an unknown quote, invalid transition, or persistence failure.
    pub fn update_settlement<T>(
        &self,
        quote_id: &QuoteReference,
        operation: impl FnOnce(&mut Settlement) -> Result<T, SettlementError>,
    ) -> Result<T, StoreError> {
        self.update(|state| {
            let quote = state
                .melt_quotes
                .get_mut(quote_id)
                .ok_or_else(|| StoreError::QuoteNotFound(quote_id.clone()))?;
            operation(&mut quote.settlement).map_err(StoreError::from)
        })
    }

    /// Validates one ordered observation and atomically records its outcome and cursor.
    ///
    /// # Errors
    ///
    /// Returns an error when state cannot be read or persisted.
    pub fn observe_payment(
        &self,
        profile: &StellarProfile,
        payment: &ObservedPayment,
    ) -> Result<ObservationOutcome, StoreError> {
        self.update(|state| {
            if state
                .paging_cursor
                .is_some_and(|cursor| payment.paging_cursor <= cursor)
            {
                return Ok(outcome_for_stale_payment(state, payment));
            }
            let result = evaluate_payment(state, profile, payment);
            state.paging_cursor = Some(payment.paging_cursor);
            Ok(result)
        })
    }

    /// Advances the durable observer cursor without moving it backward.
    ///
    /// # Errors
    ///
    /// Returns an error when state cannot be read or persisted.
    pub fn advance_cursor(&self, cursor: LedgerCursor) -> Result<(), StoreError> {
        self.update(|state| {
            if state.paging_cursor.is_none_or(|current| cursor > current) {
                state.paging_cursor = Some(cursor);
            }
            Ok(())
        })
    }

    fn update<T>(
        &self,
        operation: impl FnOnce(&mut PersistentState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut current = self.state.lock().map_err(|_| StoreError::Poisoned)?;
        let mut next = current.clone();
        let result = operation(&mut next)?;
        persist_atomically(&self.path, &next)?;
        *current = next;
        Ok(result)
    }
}

fn outcome_for_stale_payment(
    state: &PersistentState,
    payment: &ObservedPayment,
) -> ObservationOutcome {
    if let Some(quote_id) = state.claimed_operations.get(&payment.operation_id)
        && let Some(claim) = state
            .mint_quotes
            .get(quote_id)
            .and_then(MintQuoteRecord::claim)
        && claim.transaction_hash == payment.transaction_hash
    {
        return ObservationOutcome::AlreadyClaimed {
            quote_id: quote_id.clone(),
            claim: claim.clone(),
        };
    }
    ObservationOutcome::Rejected(DepositRejection::StaleCursor)
}

fn evaluate_payment(
    state: &mut PersistentState,
    profile: &StellarProfile,
    payment: &ObservedPayment,
) -> ObservationOutcome {
    let Some(memo) = payment.memo.as_deref() else {
        return ObservationOutcome::Rejected(DepositRejection::UnknownCorrelation);
    };
    if !matches!(payment.memo_type.as_deref(), Some("MEMO_HASH" | "hash")) {
        return ObservationOutcome::Rejected(DepositRejection::UnknownCorrelation);
    }
    let Some(quote_id) = state
        .mint_quotes
        .values()
        .find(|quote| quote.correlation_memo == memo)
        .map(|quote| quote.quote_id.clone())
    else {
        return ObservationOutcome::Rejected(DepositRejection::UnknownCorrelation);
    };

    if let Some(claim) = state
        .mint_quotes
        .get(&quote_id)
        .and_then(MintQuoteRecord::claim)
    {
        if claim.operation_id == payment.operation_id
            && claim.transaction_hash == payment.transaction_hash
        {
            return ObservationOutcome::AlreadyClaimed {
                quote_id,
                claim: claim.clone(),
            };
        }
        return ObservationOutcome::Rejected(DepositRejection::QuoteAlreadyPaid);
    }

    let Some(quote) = state.mint_quotes.get(&quote_id) else {
        return ObservationOutcome::Rejected(DepositRejection::InvalidValue);
    };
    let rejection = validate_payment(quote, profile, payment);
    if let Some(rejection) = rejection {
        return ObservationOutcome::Rejected(rejection);
    }
    if let Some(existing) = state.claimed_operations.get(&payment.operation_id) {
        return ObservationOutcome::Rejected(DepositRejection::ReplayedOperation(existing.clone()));
    }
    if let Some(existing) = state.claimed_transactions.get(&payment.transaction_hash) {
        return ObservationOutcome::Rejected(DepositRejection::ReplayedTransaction(
            existing.clone(),
        ));
    }

    let claim = DepositClaim {
        operation_id: payment.operation_id.clone(),
        transaction_hash: payment.transaction_hash.clone(),
        ledger_sequence: payment.ledger_sequence,
        ledger_closed_at: payment.ledger_closed_at,
    };
    let Some(quote) = state.mint_quotes.get_mut(&quote_id) else {
        return ObservationOutcome::Rejected(DepositRejection::InvalidValue);
    };
    quote.claim = Some(claim.clone());
    state
        .claimed_operations
        .insert(payment.operation_id.clone(), quote_id.clone());
    state
        .claimed_transactions
        .insert(payment.transaction_hash.clone(), quote_id.clone());
    ObservationOutcome::Claimed { quote_id, claim }
}

fn validate_payment(
    quote: &MintQuoteRecord,
    profile: &StellarProfile,
    payment: &ObservedPayment,
) -> Option<DepositRejection> {
    if payment.network_passphrase != profile.network().passphrase()
        || payment.network_id != profile.network().network_id()
    {
        return Some(DepositRejection::WrongNetwork);
    }
    if !payment.transaction_successful
        || payment.ledger_sequence == 0
        || payment.ledger_closed_at == 0
    {
        return Some(DepositRejection::NotFinal);
    }
    if &payment.destination != profile.deposit_destination() {
        return Some(DepositRejection::WrongDestination);
    }
    if payment.asset_code != profile.asset().code() {
        return Some(DepositRejection::WrongAssetCode);
    }
    if &payment.asset_issuer != profile.asset().issuer() {
        return Some(DepositRejection::WrongAssetIssuer);
    }
    match quote.amount.matches_stellar_decimal(&payment.amount) {
        Ok(true) => {}
        Ok(false) => return Some(DepositRejection::WrongAmount),
        Err(_) => return Some(DepositRejection::InvalidValue),
    }
    if payment.ledger_closed_at > quote.expires_at {
        return Some(DepositRejection::Expired);
    }
    None
}

fn persist_atomically(path: &Path, state: &PersistentState) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| StoreError::Io {
        operation: "create state directory",
        source,
    })?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|source| StoreError::Io {
        operation: "open temporary state journal",
        source,
    })?;
    file.write_all(&bytes).map_err(|source| StoreError::Io {
        operation: "write temporary state journal",
        source,
    })?;
    file.write_all(b"\n").map_err(|source| StoreError::Io {
        operation: "finish temporary state journal",
        source,
    })?;
    file.sync_all().map_err(|source| StoreError::Io {
        operation: "sync temporary state journal",
        source,
    })?;
    fs::rename(&temporary, path).map_err(|source| StoreError::Io {
        operation: "replace state journal",
        source,
    })?;
    sync_parent(parent)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), StoreError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| StoreError::Io {
            operation: "sync state directory",
            source,
        })
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<(), StoreError> {
    Ok(())
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("state journal I/O failed while attempting to {operation}")]
    Io {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("state journal contains unsupported version {0}")]
    UnsupportedStateVersion(u32),
    #[error("state store mutex was poisoned")]
    Poisoned,
    #[error("quote {0} conflicts with an existing durable record")]
    QuoteConflict(QuoteReference),
    #[error("quote {0} was not found")]
    QuoteNotFound(QuoteReference),
    #[error("mint quote correlation memo is already assigned")]
    DuplicateCorrelation,
    #[error("invalid quote: {0}")]
    InvalidQuote(&'static str),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Settlement(#[from] SettlementError),
    #[error(transparent)]
    InvalidValue(#[from] ValueError),
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::tempdir;

    use crate::{QuoteReference, StellarProfile, UsdcMinorUnits, build_deposit_request};

    use super::{MintQuoteRecord, StateStore};

    const DESTINATION: &str = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";

    #[test]
    fn quote_state_survives_store_restart() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("settlement-state.json");
        let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
        let quote_id = QuoteReference::new("quote-one").expect("valid quote id");
        let amount = UsdcMinorUnits::new(500).expect("positive amount");
        let payment = build_deposit_request(&profile, &quote_id, amount).expect("valid request");
        let quote = MintQuoteRecord::new(
            quote_id.clone(),
            amount,
            2_000_000_000,
            payment.memo().expect("deposit request has memo"),
            "fixture-pubkey",
        )
        .expect("valid quote");

        Arc::new(StateStore::open(&path).expect("store opens"))
            .insert_mint_quote(quote)
            .expect("quote persists");
        let reopened = StateStore::open(path).expect("store reopens");
        assert!(
            reopened
                .mint_quote(&quote_id)
                .expect("read works")
                .is_some()
        );
    }

    #[test]
    fn observer_cursor_never_moves_backward() {
        let directory = tempdir().expect("temporary directory");
        let store = StateStore::open(directory.path().join("state.json")).expect("store opens");
        store
            .advance_cursor(crate::LedgerCursor::new("20").expect("cursor"))
            .expect("cursor persists");
        store
            .advance_cursor(crate::LedgerCursor::new("10").expect("cursor"))
            .expect("older cursor is ignored");
        assert_eq!(
            store.snapshot().expect("snapshot").paging_cursor(),
            Some(crate::LedgerCursor::new("20").expect("cursor"))
        );
    }
}
