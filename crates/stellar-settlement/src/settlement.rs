use std::fmt::{Debug, Formatter};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{TransactionHash, ValueError};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SettlementId(String);

impl SettlementId {
    /// Creates the idempotency domain for one payout obligation.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::EmptyIdentifier`] when the value is blank.
    pub fn new(value: impl Into<String>) -> Result<Self, SettlementError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(SettlementError::EmptyIdentifier);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct PreparedTransaction {
    transaction_hash: TransactionHash,
    signed_envelope: String,
    dispatch_started: bool,
}

impl PreparedTransaction {
    #[must_use]
    pub const fn transaction_hash(&self) -> &TransactionHash {
        &self.transaction_hash
    }

    #[must_use]
    pub fn signed_envelope(&self) -> &str {
        &self.signed_envelope
    }

    #[must_use]
    pub const fn dispatch_started(&self) -> bool {
        self.dispatch_started
    }
}

impl Debug for PreparedTransaction {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedTransaction")
            .field("transaction_hash", &self.transaction_hash)
            .field("signed_envelope", &"[REDACTED]")
            .field("dispatch_started", &self.dispatch_started)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SettlementState {
    Unpaid,
    ProofsReserved,
    Submitted { transaction_hash: TransactionHash },
    Paid { transaction_hash: TransactionHash },
    Failed { reason: String },
    NeedsAttention { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Settlement {
    id: SettlementId,
    state: SettlementState,
    prepared_transaction: Option<PreparedTransaction>,
}

impl Settlement {
    #[must_use]
    pub const fn new(id: SettlementId) -> Self {
        Self {
            id,
            state: SettlementState::Unpaid,
            prepared_transaction: None,
        }
    }

    #[must_use]
    pub const fn id(&self) -> &SettlementId {
        &self.id
    }

    #[must_use]
    pub const fn state(&self) -> &SettlementState {
        &self.state
    }

    #[must_use]
    pub const fn prepared_transaction(&self) -> Option<&PreparedTransaction> {
        self.prepared_transaction.as_ref()
    }

    /// Reserves bearer proofs before any external payout effect.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::InvalidTransition`] after a later state is recorded.
    pub fn reserve_proofs(&mut self) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::Unpaid => {
                self.state = SettlementState::ProofsReserved;
                Ok(())
            }
            SettlementState::ProofsReserved => Ok(()),
            _ => Err(self.invalid_transition("reserve_proofs")),
        }
    }

    /// Persists the exact signed transaction before it can be dispatched.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid data, a conflicting transaction, or an invalid state.
    pub fn record_prepared_transaction(
        &mut self,
        transaction_hash: impl Into<String>,
        signed_envelope: impl Into<String>,
    ) -> Result<(), SettlementError> {
        if !matches!(self.state, SettlementState::ProofsReserved) {
            return Err(self.invalid_transition("record_prepared_transaction"));
        }
        let transaction_hash = TransactionHash::new(transaction_hash.into())?;
        let signed_envelope = signed_envelope.into();
        if signed_envelope.trim().is_empty() {
            return Err(SettlementError::EmptySignedEnvelope);
        }

        match &self.prepared_transaction {
            None => {
                self.prepared_transaction = Some(PreparedTransaction {
                    transaction_hash,
                    signed_envelope,
                    dispatch_started: false,
                });
                Ok(())
            }
            Some(existing)
                if existing.transaction_hash == transaction_hash
                    && existing.signed_envelope == signed_envelope =>
            {
                Ok(())
            }
            Some(existing) => Err(SettlementError::ConflictingTransaction {
                existing: existing.transaction_hash.to_string(),
                attempted: transaction_hash.to_string(),
            }),
        }
    }

    /// Records dispatch intent before the network submission call begins.
    ///
    /// # Errors
    ///
    /// Returns an error unless proofs and a prepared transaction are present.
    pub fn record_dispatch_started(&mut self) -> Result<(), SettlementError> {
        if !matches!(self.state, SettlementState::ProofsReserved) {
            return Err(self.invalid_transition("record_dispatch_started"));
        }
        let prepared = self
            .prepared_transaction
            .as_mut()
            .ok_or(SettlementError::MissingPreparedTransaction)?;
        prepared.dispatch_started = true;
        Ok(())
    }

    /// Records that the prepared transaction was accepted for submission.
    ///
    /// # Errors
    ///
    /// Returns an error for a hash mismatch, missing preparation, or invalid state.
    pub fn record_submission(
        &mut self,
        transaction_hash: impl Into<String>,
    ) -> Result<(), SettlementError> {
        let transaction_hash = TransactionHash::new(transaction_hash.into())?;
        if let Some(prepared) = &self.prepared_transaction
            && prepared.transaction_hash != transaction_hash
        {
            return Err(SettlementError::ConflictingTransaction {
                existing: prepared.transaction_hash.to_string(),
                attempted: transaction_hash.to_string(),
            });
        }

        match &self.state {
            SettlementState::ProofsReserved => {
                let prepared = self
                    .prepared_transaction
                    .as_ref()
                    .ok_or(SettlementError::MissingPreparedTransaction)?;
                if !prepared.dispatch_started {
                    return Err(SettlementError::DispatchNotStarted);
                }
                self.state = SettlementState::Submitted { transaction_hash };
                Ok(())
            }
            SettlementState::NeedsAttention { .. } => {
                self.state = SettlementState::Submitted { transaction_hash };
                Ok(())
            }
            SettlementState::Submitted {
                transaction_hash: existing,
            }
            | SettlementState::Paid {
                transaction_hash: existing,
            } if existing == &transaction_hash => Ok(()),
            SettlementState::Submitted {
                transaction_hash: existing,
            }
            | SettlementState::Paid {
                transaction_hash: existing,
            } => Err(SettlementError::ConflictingTransaction {
                existing: existing.to_string(),
                attempted: transaction_hash.to_string(),
            }),
            _ => Err(self.invalid_transition("record_submission")),
        }
    }

    /// Marks the settlement paid after observing the matching final transaction.
    ///
    /// # Errors
    ///
    /// Returns an error for a hash mismatch or invalid state.
    pub fn confirm_paid(&mut self, observed_hash: &str) -> Result<(), SettlementError> {
        let observed = TransactionHash::new(observed_hash)?;
        match &self.state {
            SettlementState::Submitted { transaction_hash } if transaction_hash == &observed => {
                self.state = SettlementState::Paid {
                    transaction_hash: transaction_hash.clone(),
                };
                Ok(())
            }
            SettlementState::NeedsAttention { .. } if self.prepared_hash() == Some(&observed) => {
                self.state = SettlementState::Paid {
                    transaction_hash: observed,
                };
                Ok(())
            }
            SettlementState::Paid { transaction_hash } if transaction_hash == &observed => Ok(()),
            SettlementState::Submitted { transaction_hash }
            | SettlementState::Paid { transaction_hash } => {
                Err(SettlementError::TransactionMismatch {
                    expected: transaction_hash.to_string(),
                    observed: observed.to_string(),
                })
            }
            SettlementState::NeedsAttention { .. } => Err(SettlementError::TransactionMismatch {
                expected: self
                    .prepared_hash()
                    .map_or_else(|| "<missing>".to_owned(), ToString::to_string),
                observed: observed.to_string(),
            }),
            _ => Err(self.invalid_transition("confirm_paid")),
        }
    }

    /// Records a provable failure before any dispatch begins.
    ///
    /// # Errors
    ///
    /// Returns an error once an external effect may exist or from a terminal state.
    pub fn record_provable_failure(
        &mut self,
        reason: impl Into<String>,
    ) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::ProofsReserved => {
                if self
                    .prepared_transaction
                    .as_ref()
                    .is_some_and(PreparedTransaction::dispatch_started)
                {
                    return Err(SettlementError::OutcomeMustBeObserved);
                }
                self.state = SettlementState::Failed {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::Submitted { .. } | SettlementState::NeedsAttention { .. } => {
                Err(SettlementError::OutcomeMustBeObserved)
            }
            _ => Err(self.invalid_transition("record_provable_failure")),
        }
    }

    /// Records an authoritative rejection of the exact submitted envelope.
    ///
    /// # Errors
    ///
    /// Returns an error unless dispatch was durably started and no later state exists.
    pub fn record_dispatch_rejected(
        &mut self,
        reason: impl Into<String>,
    ) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::ProofsReserved
                if self
                    .prepared_transaction
                    .as_ref()
                    .is_some_and(PreparedTransaction::dispatch_started) =>
            {
                self.state = SettlementState::Failed {
                    reason: reason.into(),
                };
                Ok(())
            }
            _ => Err(self.invalid_transition("record_dispatch_rejected")),
        }
    }

    /// Records an observed final failure for the exact prepared transaction.
    ///
    /// # Errors
    ///
    /// Returns an error for a hash mismatch or invalid state.
    pub fn record_observed_failure(
        &mut self,
        transaction_hash: &str,
        reason: impl Into<String>,
    ) -> Result<(), SettlementError> {
        let transaction_hash = TransactionHash::new(transaction_hash)?;
        if self.prepared_hash() != Some(&transaction_hash) {
            return Err(SettlementError::TransactionMismatch {
                expected: self
                    .prepared_hash()
                    .map_or_else(|| "<missing>".to_owned(), ToString::to_string),
                observed: transaction_hash.to_string(),
            });
        }
        match self.state {
            SettlementState::ProofsReserved
            | SettlementState::Submitted { .. }
            | SettlementState::NeedsAttention { .. } => {
                self.state = SettlementState::Failed {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::Failed { .. } => Ok(()),
            _ => Err(self.invalid_transition("record_observed_failure")),
        }
    }

    /// Keeps proofs reserved when a dispatched outcome cannot be classified.
    ///
    /// # Errors
    ///
    /// Returns an error unless an external effect may exist.
    pub fn require_attention(&mut self, reason: impl Into<String>) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::Submitted { .. } => {
                self.state = SettlementState::NeedsAttention {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::ProofsReserved
                if self
                    .prepared_transaction
                    .as_ref()
                    .is_some_and(PreparedTransaction::dispatch_started) =>
            {
                self.state = SettlementState::NeedsAttention {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::NeedsAttention { .. } => Ok(()),
            _ => Err(self.invalid_transition("require_attention")),
        }
    }

    fn prepared_hash(&self) -> Option<&TransactionHash> {
        self.prepared_transaction
            .as_ref()
            .map(PreparedTransaction::transaction_hash)
    }

    const fn invalid_transition(&self, action: &'static str) -> SettlementError {
        SettlementError::InvalidTransition {
            action,
            current: self.state_name(),
        }
    }

    const fn state_name(&self) -> &'static str {
        match self.state {
            SettlementState::Unpaid => "unpaid",
            SettlementState::ProofsReserved => "proofs_reserved",
            SettlementState::Submitted { .. } => "submitted",
            SettlementState::Paid { .. } => "paid",
            SettlementState::Failed { .. } => "failed",
            SettlementState::NeedsAttention { .. } => "needs_attention",
        }
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum SettlementError {
    #[error("settlement identifier cannot be empty")]
    EmptyIdentifier,
    #[error("signed transaction envelope cannot be empty")]
    EmptySignedEnvelope,
    #[error("a prepared transaction must be persisted before dispatch")]
    MissingPreparedTransaction,
    #[error("dispatch intent must be persisted before submission is recorded")]
    DispatchNotStarted,
    #[error("settlement already references transaction {existing}; refusing {attempted}")]
    ConflictingTransaction { existing: String, attempted: String },
    #[error("observed transaction {observed} does not match transaction {expected}")]
    TransactionMismatch { expected: String, observed: String },
    #[error("a transaction may have been dispatched; observe it before releasing proofs")]
    OutcomeMustBeObserved,
    #[error("cannot {action} while settlement is {current}")]
    InvalidTransition {
        action: &'static str,
        current: &'static str,
    },
    #[error(transparent)]
    InvalidValue(#[from] ValueError),
}

#[cfg(test)]
mod tests {
    use super::{Settlement, SettlementError, SettlementId, SettlementState};

    const TX_ONE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const TX_TWO: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn settlement() -> Settlement {
        Settlement::new(SettlementId::new("settlement-001").expect("valid identifier"))
    }

    fn prepare(settlement: &mut Settlement) {
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_prepared_transaction(TX_ONE, "fixture-envelope")
            .expect("transaction can be prepared");
        settlement
            .record_dispatch_started()
            .expect("dispatch can begin");
    }

    #[test]
    fn completes_the_expected_state_path() {
        let mut settlement = settlement();
        prepare(&mut settlement);
        settlement
            .record_submission(TX_ONE)
            .expect("submission can be recorded");
        settlement
            .confirm_paid(TX_ONE)
            .expect("matching transaction can be confirmed");
        assert!(matches!(settlement.state(), SettlementState::Paid { .. }));
    }

    #[test]
    fn refuses_a_second_transaction_for_one_settlement() {
        let mut settlement = settlement();
        prepare(&mut settlement);
        assert_eq!(
            settlement.record_submission(TX_TWO),
            Err(SettlementError::ConflictingTransaction {
                existing: TX_ONE.to_owned(),
                attempted: TX_TWO.to_owned(),
            })
        );
    }

    #[test]
    fn refuses_to_release_after_dispatch_started() {
        let mut settlement = settlement();
        prepare(&mut settlement);
        assert_eq!(
            settlement.record_provable_failure("timeout"),
            Err(SettlementError::OutcomeMustBeObserved)
        );
    }

    #[test]
    fn redacts_the_prepared_envelope_from_debug_output() {
        let mut settlement = settlement();
        prepare(&mut settlement);
        let rendered = format!("{settlement:?}");
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains("fixture-envelope"));
    }
}
