use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementId(String);

impl SettlementId {
    /// Creates the idempotency domain for one logical merchant settlement.
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementState {
    Unpaid,
    ProofsReserved,
    Submitted { transaction_hash: String },
    Paid { transaction_hash: String },
    Failed { reason: String },
    NeedsAttention { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    id: SettlementId,
    state: SettlementState,
}

impl Settlement {
    #[must_use]
    pub const fn new(id: SettlementId) -> Self {
        Self {
            id,
            state: SettlementState::Unpaid,
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

    /// Reserves bearer proofs before any external payout effect.
    ///
    /// Repeating the reservation is idempotent.
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
            _ => Err(SettlementError::InvalidTransition {
                action: "reserve_proofs",
                current: self.state_name(),
            }),
        }
    }

    /// Records the observable identifier of the submitted Stellar transaction.
    ///
    /// Repeating the same hash is idempotent. A different hash is rejected because one settlement
    /// identifier must never map to two payouts.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::EmptyTransactionHash`],
    /// [`SettlementError::ConflictingTransaction`], or [`SettlementError::InvalidTransition`].
    pub fn record_submission(
        &mut self,
        transaction_hash: impl Into<String>,
    ) -> Result<(), SettlementError> {
        let transaction_hash = transaction_hash.into();
        if transaction_hash.trim().is_empty() {
            return Err(SettlementError::EmptyTransactionHash);
        }

        match &self.state {
            SettlementState::ProofsReserved => {
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
                existing: existing.clone(),
                attempted: transaction_hash,
            }),
            _ => Err(SettlementError::InvalidTransition {
                action: "record_submission",
                current: self.state_name(),
            }),
        }
    }

    /// Confirms a previously observed Stellar transaction and consumes the settlement obligation.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::TransactionMismatch`] when the observed hash differs or
    /// [`SettlementError::InvalidTransition`] when no transaction is pending.
    pub fn confirm_paid(&mut self, observed_hash: &str) -> Result<(), SettlementError> {
        match &self.state {
            SettlementState::Submitted { transaction_hash }
                if transaction_hash == observed_hash =>
            {
                self.state = SettlementState::Paid {
                    transaction_hash: transaction_hash.clone(),
                };
                Ok(())
            }
            SettlementState::Paid { transaction_hash } if transaction_hash == observed_hash => {
                Ok(())
            }
            SettlementState::Submitted { transaction_hash }
            | SettlementState::Paid { transaction_hash } => {
                Err(SettlementError::TransactionMismatch {
                    expected: transaction_hash.clone(),
                    observed: observed_hash.to_owned(),
                })
            }
            _ => Err(SettlementError::InvalidTransition {
                action: "confirm_paid",
                current: self.state_name(),
            }),
        }
    }

    /// Records a failure only when no transaction has been submitted.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::OutcomeMustBeObserved`] after submission or
    /// [`SettlementError::InvalidTransition`] from another terminal state.
    pub fn record_provable_failure(
        &mut self,
        reason: impl Into<String>,
    ) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::ProofsReserved => {
                self.state = SettlementState::Failed {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::Submitted { .. } => Err(SettlementError::OutcomeMustBeObserved),
            _ => Err(SettlementError::InvalidTransition {
                action: "record_provable_failure",
                current: self.state_name(),
            }),
        }
    }

    /// Marks an ambiguous submitted effect for reconciliation instead of releasing its proofs.
    ///
    /// # Errors
    ///
    /// Returns [`SettlementError::InvalidTransition`] when no submitted effect exists.
    pub fn require_attention(&mut self, reason: impl Into<String>) -> Result<(), SettlementError> {
        match self.state {
            SettlementState::Submitted { .. } => {
                self.state = SettlementState::NeedsAttention {
                    reason: reason.into(),
                };
                Ok(())
            }
            SettlementState::NeedsAttention { .. } => Ok(()),
            _ => Err(SettlementError::InvalidTransition {
                action: "require_attention",
                current: self.state_name(),
            }),
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementError {
    EmptyIdentifier,
    EmptyTransactionHash,
    ConflictingTransaction {
        existing: String,
        attempted: String,
    },
    TransactionMismatch {
        expected: String,
        observed: String,
    },
    OutcomeMustBeObserved,
    InvalidTransition {
        action: &'static str,
        current: &'static str,
    },
}

impl Display for SettlementError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdentifier => formatter.write_str("settlement identifier cannot be empty"),
            Self::EmptyTransactionHash => formatter.write_str("transaction hash cannot be empty"),
            Self::ConflictingTransaction {
                existing,
                attempted,
            } => write!(
                formatter,
                "settlement already references transaction {existing}; refusing {attempted}"
            ),
            Self::TransactionMismatch { expected, observed } => write!(
                formatter,
                "observed transaction {observed} does not match submitted transaction {expected}"
            ),
            Self::OutcomeMustBeObserved => formatter.write_str(
                "a transaction was submitted; observe its remote state before recording failure",
            ),
            Self::InvalidTransition { action, current } => {
                write!(formatter, "cannot {action} while settlement is {current}")
            }
        }
    }
}

impl Error for SettlementError {}

#[cfg(test)]
mod tests {
    use super::{Settlement, SettlementError, SettlementId, SettlementState};

    fn settlement() -> Settlement {
        Settlement::new(SettlementId::new("settlement-001").expect("valid identifier"))
    }

    #[test]
    fn rejects_empty_identifier() {
        assert_eq!(
            SettlementId::new("  "),
            Err(SettlementError::EmptyIdentifier)
        );
    }

    #[test]
    fn completes_the_expected_state_path() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_submission("tx-001")
            .expect("submission can be recorded");
        settlement
            .confirm_paid("tx-001")
            .expect("matching transaction can be confirmed");

        assert_eq!(
            settlement.state(),
            &SettlementState::Paid {
                transaction_hash: "tx-001".to_owned()
            }
        );
    }

    #[test]
    fn repeated_submission_of_the_same_transaction_is_idempotent() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_submission("tx-001")
            .expect("submission can be recorded");

        assert_eq!(settlement.record_submission("tx-001"), Ok(()));
    }

    #[test]
    fn refuses_a_second_transaction_for_one_settlement() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_submission("tx-001")
            .expect("submission can be recorded");

        assert_eq!(
            settlement.record_submission("tx-002"),
            Err(SettlementError::ConflictingTransaction {
                existing: "tx-001".to_owned(),
                attempted: "tx-002".to_owned(),
            })
        );
    }

    #[test]
    fn refuses_to_fail_an_ambiguous_submitted_effect() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_submission("tx-001")
            .expect("submission can be recorded");

        assert_eq!(
            settlement.record_provable_failure("timeout"),
            Err(SettlementError::OutcomeMustBeObserved)
        );
        assert!(matches!(
            settlement.state(),
            SettlementState::Submitted { .. }
        ));
    }

    #[test]
    fn records_failure_before_any_external_effect() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_provable_failure("invalid destination")
            .expect("provable pre-submission failure is safe");

        assert_eq!(
            settlement.state(),
            &SettlementState::Failed {
                reason: "invalid destination".to_owned()
            }
        );
    }

    #[test]
    fn routes_an_ambiguous_effect_to_manual_attention() {
        let mut settlement = settlement();
        settlement.reserve_proofs().expect("proofs can be reserved");
        settlement
            .record_submission("tx-001")
            .expect("submission can be recorded");
        settlement
            .require_attention("remote lookup unavailable")
            .expect("submitted effect can require attention");

        assert_eq!(
            settlement.state(),
            &SettlementState::NeedsAttention {
                reason: "remote lookup unavailable".to_owned()
            }
        );
    }
}
