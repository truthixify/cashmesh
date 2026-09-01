use std::sync::Arc;

use async_trait::async_trait;
use stellar_base::PublicKey;
use stellar_horizon::api::{self, Join};
use stellar_horizon::client::{HorizonClient, HorizonHttpClient};
use stellar_horizon::request::{Order, PageRequest};
use stellar_horizon::resources::Payment;
use thiserror::Error;

use crate::{
    DepositBatch, DepositSource, LedgerCursor, ObservedPayment, PaymentOperationId, StellarAddress,
    StellarProfile, TransactionHash, profile::network_id_for_passphrase,
};

pub struct HorizonDepositSource {
    client: HorizonHttpClient,
    profile: Arc<StellarProfile>,
    destination: PublicKey,
}

impl HorizonDepositSource {
    /// Creates a read-only Horizon source for the configured deposit account.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid endpoint or deposit account.
    pub fn new(profile: Arc<StellarProfile>) -> Result<Self, HorizonAdapterError> {
        let client = HorizonHttpClient::new_from_str(profile.network().horizon_url())?;
        let destination = PublicKey::from_account_id(profile.deposit_destination().as_str())?;
        Ok(Self {
            client,
            profile,
            destination,
        })
    }

    async fn verify_root(&self) -> Result<(), HorizonAdapterError> {
        let (_, root) = self.client.request(api::root::root()).await?;
        let observed_id = network_id_for_passphrase(&root.network_passphrase);
        if root.network_passphrase != self.profile.network().passphrase()
            || observed_id != self.profile.network().network_id()
        {
            return Err(HorizonAdapterError::WrongNetwork);
        }
        Ok(())
    }
}

#[async_trait]
impl DepositSource for HorizonDepositSource {
    async fn verify_network(&self) -> Result<(), crate::processor::ExternalError> {
        self.verify_root()
            .await
            .map_err(|error| Box::new(error) as crate::processor::ExternalError)
    }

    async fn payments_after(
        &self,
        cursor: Option<LedgerCursor>,
    ) -> Result<DepositBatch, crate::processor::ExternalError> {
        self.verify_root()
            .await
            .map_err(|error| Box::new(error) as crate::processor::ExternalError)?;
        let mut request = api::payments::for_account(&self.destination)
            .with_join(Join::Transactions)
            .with_include_failed(true)
            .with_order(&Order::Ascending)
            .with_limit(200);
        if let Some(cursor) = cursor {
            request = request.with_cursor(&cursor.to_string());
        }
        let (_, page) = self
            .client
            .request(request)
            .await
            .map_err(|error| Box::new(error) as crate::processor::ExternalError)?;
        let next_cursor = page
            .records
            .last()
            .map(Payment::base)
            .map(|base| LedgerCursor::new(&base.paging_token))
            .transpose()
            .map_err(|error| Box::new(error) as crate::processor::ExternalError)?;
        let payments = page
            .records
            .iter()
            .filter_map(|payment| normalize_horizon_payment(&self.profile, payment).transpose())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| Box::new(error) as crate::processor::ExternalError)?;
        Ok(DepositBatch {
            payments,
            cursor: next_cursor,
        })
    }
}

/// Converts a joined direct-payment response into the `CashMesh` observation model.
///
/// # Errors
///
/// Returns an error when required transaction, ledger, asset, address, or identifier data is invalid.
pub fn normalize_horizon_payment(
    profile: &StellarProfile,
    payment: &Payment,
) -> Result<Option<ObservedPayment>, HorizonAdapterError> {
    let Payment::Payment(payment) = payment else {
        return Ok(None);
    };
    if !matches!(
        payment.asset.asset_type.as_str(),
        "credit_alphanum4" | "credit_alphanum12"
    ) {
        return Ok(None);
    }
    let transaction = payment
        .base
        .transaction
        .as_ref()
        .ok_or(HorizonAdapterError::MissingJoinedTransaction)?;
    if payment.base.transaction_hash != transaction.hash
        || payment.base.transaction_hash != transaction.id
    {
        return Err(HorizonAdapterError::TransactionHashMismatch);
    }
    let ledger_sequence = u32::try_from(transaction.ledger)
        .map_err(|_| HorizonAdapterError::InvalidLedgerSequence)?;
    let ledger_closed_at = u64::try_from(transaction.created_at.timestamp())
        .map_err(|_| HorizonAdapterError::InvalidCloseTime)?;
    let asset_code = payment
        .asset
        .asset_code
        .clone()
        .ok_or(HorizonAdapterError::MissingAsset)?;
    let asset_issuer = payment
        .asset
        .asset_issuer
        .clone()
        .ok_or(HorizonAdapterError::MissingAsset)?;

    Ok(Some(ObservedPayment {
        network_passphrase: profile.network().passphrase().to_owned(),
        network_id: profile.network().network_id().to_owned(),
        operation_id: PaymentOperationId::new(&payment.base.id)?,
        paging_cursor: LedgerCursor::new(&payment.base.paging_token)?,
        transaction_hash: TransactionHash::new(&payment.base.transaction_hash)?,
        ledger_sequence,
        transaction_successful: payment.base.transaction_successful && transaction.successful,
        ledger_closed_at,
        destination: StellarAddress::new(
            payment.to_muxed.as_deref().unwrap_or(payment.to.as_str()),
        )?,
        asset_code,
        asset_issuer: StellarAddress::new_account(asset_issuer)?,
        amount: payment.amount.clone(),
        memo: transaction
            .memo
            .clone()
            .or_else(|| transaction.memo_bytes.clone()),
        memo_type: Some(transaction.memo_type.clone()),
    }))
}

#[derive(Debug, Error)]
pub enum HorizonAdapterError {
    #[error("Horizon endpoint reports a different network passphrase")]
    WrongNetwork,
    #[error("Horizon payment response omitted the joined transaction")]
    MissingJoinedTransaction,
    #[error("Horizon operation and joined transaction hashes do not match")]
    TransactionHashMismatch,
    #[error("Horizon payment response omitted credit asset fields")]
    MissingAsset,
    #[error("Horizon returned an invalid ledger sequence")]
    InvalidLedgerSequence,
    #[error("Horizon returned an invalid ledger close time")]
    InvalidCloseTime,
    #[error("Horizon request failed")]
    Horizon(#[source] Box<stellar_horizon::error::Error>),
    #[error(transparent)]
    StellarBase(#[from] stellar_base::error::Error),
    #[error(transparent)]
    Value(#[from] crate::ValueError),
}

impl From<stellar_horizon::error::Error> for HorizonAdapterError {
    fn from(error: stellar_horizon::error::Error) -> Self {
        Self::Horizon(Box::new(error))
    }
}
