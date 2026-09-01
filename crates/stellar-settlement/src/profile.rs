use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::{StellarAddress, UsdcMinorUnits, ValueError};

pub const STELLAR_METHOD: &str = "stellar";
pub const STELLAR_TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";
pub const STELLAR_TESTNET_NETWORK_ID: &str =
    "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472";
pub const STELLAR_TESTNET_HORIZON_URL: &str = "https://horizon-testnet.stellar.org";
pub const CIRCLE_TESTNET_USDC_ISSUER: &str =
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StellarNetwork {
    passphrase: String,
    network_id: String,
    horizon_url: String,
}

impl StellarNetwork {
    /// Creates a network identity whose id is derived from its passphrase.
    ///
    /// # Errors
    ///
    /// Returns an error when the id does not match or the Horizon endpoint is not HTTPS.
    pub fn new(
        passphrase: impl Into<String>,
        network_id: impl Into<String>,
        horizon_url: impl Into<String>,
    ) -> Result<Self, ProfileError> {
        let passphrase = passphrase.into();
        let network_id = network_id.into().to_ascii_lowercase();
        let horizon_url = horizon_url.into();
        let derived = network_id_for_passphrase(&passphrase);
        if derived != network_id {
            return Err(ProfileError::NetworkIdMismatch {
                configured: network_id,
                derived,
            });
        }
        let parsed_url = Url::parse(&horizon_url).map_err(ProfileError::InvalidHorizonUrl)?;
        if parsed_url.scheme() != "https" || parsed_url.host_str().is_none() {
            return Err(ProfileError::InsecureHorizonUrl);
        }
        Ok(Self {
            passphrase,
            network_id,
            horizon_url,
        })
    }

    /// Returns the pinned Stellar testnet identity.
    ///
    /// # Errors
    ///
    /// Returns an error if the compile-time network constants are inconsistent.
    pub fn testnet() -> Result<Self, ProfileError> {
        Self::new(
            STELLAR_TESTNET_PASSPHRASE,
            STELLAR_TESTNET_NETWORK_ID,
            STELLAR_TESTNET_HORIZON_URL,
        )
    }

    #[must_use]
    pub fn passphrase(&self) -> &str {
        &self.passphrase
    }

    #[must_use]
    pub fn network_id(&self) -> &str {
        &self.network_id
    }

    #[must_use]
    pub fn horizon_url(&self) -> &str {
        &self.horizon_url
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StellarAsset {
    code: String,
    issuer: StellarAddress,
}

impl StellarAsset {
    /// Creates an issued Stellar asset tuple.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid asset code or issuer G-address.
    pub fn new(code: impl Into<String>, issuer: impl Into<String>) -> Result<Self, ProfileError> {
        let code = code.into();
        if !(1..=12).contains(&code.len())
            || !code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        {
            return Err(ProfileError::InvalidAssetCode);
        }
        Ok(Self {
            code,
            issuer: StellarAddress::new_account(issuer).map_err(ProfileError::InvalidValue)?,
        })
    }

    /// Returns the pinned Circle testnet USDC asset.
    ///
    /// # Errors
    ///
    /// Returns an error if the compile-time asset constants are invalid.
    pub fn testnet_usdc() -> Result<Self, ProfileError> {
        Self::new("USDC", CIRCLE_TESTNET_USDC_ISSUER)
    }

    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    #[must_use]
    pub const fn issuer(&self) -> &StellarAddress {
        &self.issuer
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StellarProfile {
    network: StellarNetwork,
    asset: StellarAsset,
    deposit_destination: StellarAddress,
    min_amount: UsdcMinorUnits,
    max_amount: UsdcMinorUnits,
    quote_ttl_seconds: u64,
}

impl StellarProfile {
    /// Creates a bounded settlement profile.
    ///
    /// # Errors
    ///
    /// Returns an error for an inverted amount range or zero quote TTL.
    pub fn new(
        network: StellarNetwork,
        asset: StellarAsset,
        deposit_destination: StellarAddress,
        min_amount: UsdcMinorUnits,
        max_amount: UsdcMinorUnits,
        quote_ttl_seconds: u64,
    ) -> Result<Self, ProfileError> {
        if min_amount > max_amount {
            return Err(ProfileError::InvalidAmountRange);
        }
        if quote_ttl_seconds == 0 {
            return Err(ProfileError::InvalidQuoteTtl);
        }
        Ok(Self {
            network,
            asset,
            deposit_destination,
            min_amount,
            max_amount,
            quote_ttl_seconds,
        })
    }

    /// Creates the initial `CashMesh` testnet USDC profile.
    ///
    /// # Errors
    ///
    /// Returns an error if the destination or pinned testnet constants are invalid.
    pub fn testnet_usdc(deposit_destination: impl Into<String>) -> Result<Self, ProfileError> {
        Self::new(
            StellarNetwork::testnet()?,
            StellarAsset::testnet_usdc()?,
            StellarAddress::new_account(deposit_destination).map_err(ProfileError::InvalidValue)?,
            UsdcMinorUnits::new(1).map_err(ProfileError::InvalidValue)?,
            UsdcMinorUnits::new(25_000).map_err(ProfileError::InvalidValue)?,
            900,
        )
    }

    #[must_use]
    pub const fn network(&self) -> &StellarNetwork {
        &self.network
    }

    #[must_use]
    pub const fn asset(&self) -> &StellarAsset {
        &self.asset
    }

    #[must_use]
    pub const fn deposit_destination(&self) -> &StellarAddress {
        &self.deposit_destination
    }

    #[must_use]
    pub const fn min_amount(&self) -> UsdcMinorUnits {
        self.min_amount
    }

    #[must_use]
    pub const fn max_amount(&self) -> UsdcMinorUnits {
        self.max_amount
    }

    #[must_use]
    pub const fn quote_ttl_seconds(&self) -> u64 {
        self.quote_ttl_seconds
    }

    /// Checks that an amount is inside the configured inclusive limits.
    ///
    /// # Errors
    ///
    /// Returns [`ProfileError::AmountOutsideLimits`] when it is outside the range.
    pub fn validate_amount(&self, amount: UsdcMinorUnits) -> Result<(), ProfileError> {
        if amount < self.min_amount || amount > self.max_amount {
            return Err(ProfileError::AmountOutsideLimits {
                amount: amount.value(),
                minimum: self.min_amount.value(),
                maximum: self.max_amount.value(),
            });
        }
        Ok(())
    }
}

#[must_use]
pub fn network_id_for_passphrase(passphrase: &str) -> String {
    let digest = Sha256::digest(passphrase.as_bytes());
    let mut network_id = String::with_capacity(64);
    for byte in digest {
        network_id.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        network_id.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    network_id
}

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("configured network id {configured} does not match passphrase-derived id {derived}")]
    NetworkIdMismatch { configured: String, derived: String },
    #[error("Horizon endpoint must be an absolute HTTPS URL")]
    InsecureHorizonUrl,
    #[error("invalid Horizon URL")]
    InvalidHorizonUrl(#[source] url::ParseError),
    #[error("asset code must contain 1 to 12 uppercase ASCII letters or digits")]
    InvalidAssetCode,
    #[error("minimum amount cannot exceed maximum amount")]
    InvalidAmountRange,
    #[error("quote TTL must be greater than zero")]
    InvalidQuoteTtl,
    #[error("amount {amount} is outside configured limits {minimum}..={maximum}")]
    AmountOutsideLimits {
        amount: u64,
        minimum: u64,
        maximum: u64,
    },
    #[error(transparent)]
    InvalidValue(#[from] ValueError),
}

#[cfg(test)]
mod tests {
    use super::{
        STELLAR_TESTNET_NETWORK_ID, STELLAR_TESTNET_PASSPHRASE, network_id_for_passphrase,
    };

    #[test]
    fn derives_the_documented_testnet_network_id() {
        assert_eq!(
            network_id_for_passphrase(STELLAR_TESTNET_PASSPHRASE),
            STELLAR_TESTNET_NETWORK_ID
        );
    }
}
