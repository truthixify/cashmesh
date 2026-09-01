use std::fmt::{Display, Formatter};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use stellar_strkey::Strkey;
use thiserror::Error;

const STROOPS_PER_CENT: u64 = 100_000;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct QuoteReference(String);

impl QuoteReference {
    /// Creates a nonempty quote correlation value.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::Empty`] when the value is blank.
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        nonempty(value, "quote reference").map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for QuoteReference {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaymentOperationId(String);

impl PaymentOperationId {
    /// Creates a nonempty Horizon operation identifier.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::Empty`] when the value is blank.
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        nonempty(value, "payment operation id").map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for PaymentOperationId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TransactionHash(String);

impl TransactionHash {
    /// Parses a canonical Stellar transaction hash.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::InvalidTransactionHash`] unless the value is 64 hexadecimal bytes.
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = nonempty(value, "transaction hash")?;
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ValueError::InvalidTransactionHash);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for TransactionHash {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LedgerCursor(u128);

impl LedgerCursor {
    /// Parses a Horizon paging token as an unsigned integer.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::InvalidLedgerCursor`] for nondecimal or overflowing values.
    pub fn new(value: impl AsRef<str>) -> Result<Self, ValueError> {
        let value = value.as_ref();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ValueError::InvalidLedgerCursor);
        }
        value
            .parse::<u128>()
            .map(Self)
            .map_err(|_| ValueError::InvalidLedgerCursor)
    }

    #[must_use]
    pub const fn value(self) -> u128 {
        self.0
    }
}

impl Display for LedgerCursor {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StellarAddress(String);

impl StellarAddress {
    /// Parses a Stellar G- or M-address.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::InvalidStellarAddress`] for another Strkey type or invalid encoding.
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = nonempty(value, "Stellar address")?;
        match Strkey::from_str(&value) {
            Ok(Strkey::PublicKeyEd25519(_) | Strkey::MuxedAccountEd25519(_)) => Ok(Self(value)),
            _ => Err(ValueError::InvalidStellarAddress),
        }
    }

    /// Parses a Stellar G-address suitable for an issuer or account endpoint.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::InvalidStellarAccount`] for another Strkey type or invalid encoding.
    pub fn new_account(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = nonempty(value, "Stellar account")?;
        match Strkey::from_str(&value) {
            Ok(Strkey::PublicKeyEd25519(_)) => Ok(Self(value)),
            _ => Err(ValueError::InvalidStellarAccount),
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for StellarAddress {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UsdcMinorUnits(u64);

impl UsdcMinorUnits {
    /// Creates a positive integer cent amount.
    ///
    /// # Errors
    ///
    /// Returns [`ValueError::ZeroAmount`] for zero.
    pub fn new(value: u64) -> Result<Self, ValueError> {
        if value == 0 {
            return Err(ValueError::ZeroAmount);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }

    #[must_use]
    pub fn to_decimal(self) -> String {
        format!("{}.{:02}", self.0 / 100, self.0 % 100)
    }

    /// Converts a Stellar decimal into exact USDC cents.
    ///
    /// # Errors
    ///
    /// Returns an amount error for invalid syntax, overflow, zero, or sub-cent precision.
    pub fn from_stellar_decimal(value: &str) -> Result<Self, ValueError> {
        let stroops = StellarAmount::parse(value)?.stroops();
        if stroops == 0 || stroops % STROOPS_PER_CENT != 0 {
            return Err(ValueError::SubCentAmount);
        }
        Self::new(stroops / STROOPS_PER_CENT)
    }

    /// Compares this cent amount with a Stellar decimal without floating point.
    ///
    /// # Errors
    ///
    /// Returns an amount error when the decimal is invalid or arithmetic overflows.
    pub fn matches_stellar_decimal(self, value: &str) -> Result<bool, ValueError> {
        let expected = self
            .0
            .checked_mul(STROOPS_PER_CENT)
            .ok_or(ValueError::AmountOverflow)?;
        Ok(StellarAmount::parse(value)?.stroops() == expected)
    }
}

impl Display for UsdcMinorUnits {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StellarAmount(u64);

impl StellarAmount {
    /// Parses a nonnegative Stellar amount with at most seven decimal places.
    ///
    /// # Errors
    ///
    /// Returns an amount error for invalid syntax or overflow.
    pub fn parse(value: &str) -> Result<Self, ValueError> {
        if value.is_empty() || value.starts_with(['+', '-']) || value.contains(['e', 'E']) {
            return Err(ValueError::InvalidDecimalAmount);
        }

        let mut parts = value.split('.');
        let whole = parts.next().ok_or(ValueError::InvalidDecimalAmount)?;
        let fraction = parts.next().unwrap_or("");
        if parts.next().is_some()
            || whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.len() > 7
        {
            return Err(ValueError::InvalidDecimalAmount);
        }

        let whole = whole
            .parse::<u64>()
            .map_err(|_| ValueError::AmountOverflow)?;
        let fractional = if fraction.is_empty() {
            0
        } else {
            fraction
                .parse::<u64>()
                .map_err(|_| ValueError::InvalidDecimalAmount)?
                .checked_mul(10_u64.pow(7 - u32::try_from(fraction.len()).unwrap_or(7)))
                .ok_or(ValueError::AmountOverflow)?
        };
        let stroops = whole
            .checked_mul(10_000_000)
            .and_then(|amount| amount.checked_add(fractional))
            .ok_or(ValueError::AmountOverflow)?;
        Ok(Self(stroops))
    }

    #[must_use]
    pub const fn stroops(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ValueError {
    #[error("{0} cannot be empty")]
    Empty(&'static str),
    #[error("Stellar address must be a valid G- or M-address")]
    InvalidStellarAddress,
    #[error("Stellar account must be a valid G-address")]
    InvalidStellarAccount,
    #[error("transaction hash must be 64 hexadecimal characters")]
    InvalidTransactionHash,
    #[error("ledger cursor must be an unsigned decimal integer")]
    InvalidLedgerCursor,
    #[error("amount must be greater than zero")]
    ZeroAmount,
    #[error("amount is not a plain Stellar decimal with at most seven fractional digits")]
    InvalidDecimalAmount,
    #[error("amount cannot be represented safely")]
    AmountOverflow,
    #[error("USDC amount must resolve to an exact cent")]
    SubCentAmount,
}

fn nonempty(value: impl Into<String>, name: &'static str) -> Result<String, ValueError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(ValueError::Empty(name));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{StellarAmount, UsdcMinorUnits, ValueError};

    #[test]
    fn converts_minor_units_without_floating_point() {
        let amount = UsdcMinorUnits::new(1_234).expect("positive amount");
        assert_eq!(amount.to_decimal(), "12.34");
        assert!(
            amount
                .matches_stellar_decimal("12.3400000")
                .expect("valid Stellar decimal")
        );
    }

    #[test]
    fn rejects_sub_cent_and_exponent_amounts() {
        assert_eq!(
            UsdcMinorUnits::from_stellar_decimal("1.001"),
            Err(ValueError::SubCentAmount)
        );
        assert_eq!(
            StellarAmount::parse("1e2"),
            Err(ValueError::InvalidDecimalAmount)
        );
    }
}
