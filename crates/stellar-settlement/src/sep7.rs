use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::{Url, form_urlencoded};

use crate::{
    QuoteReference, StellarAddress, StellarProfile, UsdcMinorUnits, ValueError,
    profile::ProfileError,
};

const SEP7_SCHEME: &str = "web+stellar";
const SEP7_OPERATION: &str = "pay";
const MEMO_HASH: &str = "MEMO_HASH";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Sep7Payment {
    destination: StellarAddress,
    amount: UsdcMinorUnits,
    asset_code: String,
    asset_issuer: StellarAddress,
    network_passphrase: String,
    memo: Option<String>,
    memo_type: Option<String>,
}

impl Sep7Payment {
    #[must_use]
    pub const fn destination(&self) -> &StellarAddress {
        &self.destination
    }

    #[must_use]
    pub const fn amount(&self) -> UsdcMinorUnits {
        self.amount
    }

    #[must_use]
    pub fn asset_code(&self) -> &str {
        &self.asset_code
    }

    #[must_use]
    pub const fn asset_issuer(&self) -> &StellarAddress {
        &self.asset_issuer
    }

    #[must_use]
    pub fn network_passphrase(&self) -> &str {
        &self.network_passphrase
    }

    #[must_use]
    pub fn memo(&self) -> Option<&str> {
        self.memo.as_deref()
    }

    #[must_use]
    pub fn memo_type(&self) -> Option<&str> {
        self.memo_type.as_deref()
    }

    #[must_use]
    pub fn to_uri(&self) -> String {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.append_pair("destination", self.destination.as_str());
        query.append_pair("amount", &self.amount.to_decimal());
        query.append_pair("asset_code", &self.asset_code);
        query.append_pair("asset_issuer", self.asset_issuer.as_str());
        if let Some(memo) = &self.memo {
            query.append_pair("memo", memo);
        }
        if let Some(memo_type) = &self.memo_type {
            query.append_pair("memo_type", memo_type);
        }
        query.append_pair("network_passphrase", &self.network_passphrase);
        format!("web+stellar:pay?{}", query.finish())
    }
}

/// Builds a deterministic unsigned SEP-0007 request with a quote-derived memo hash.
///
/// # Errors
///
/// Returns an error when the amount is outside the configured profile limits.
pub fn build_deposit_request(
    profile: &StellarProfile,
    quote_id: &QuoteReference,
    amount: UsdcMinorUnits,
) -> Result<Sep7Payment, Sep7Error> {
    profile.validate_amount(amount)?;
    let memo = STANDARD.encode(Sha256::digest(quote_id.as_str().as_bytes()));
    Ok(Sep7Payment {
        destination: profile.deposit_destination().clone(),
        amount,
        asset_code: profile.asset().code().to_owned(),
        asset_issuer: profile.asset().issuer().clone(),
        network_passphrase: profile.network().passphrase().to_owned(),
        memo: Some(memo),
        memo_type: Some(MEMO_HASH.to_owned()),
    })
}

/// Parses and validates the strict `CashMesh` subset of a SEP-0007 payment request.
///
/// # Errors
///
/// Returns an error for malformed requests or any network, asset, amount, or parameter mismatch.
pub fn parse_payment_request(
    profile: &StellarProfile,
    request: &str,
) -> Result<Sep7Payment, Sep7Error> {
    let url = Url::parse(request).map_err(Sep7Error::InvalidUri)?;
    if url.scheme() != SEP7_SCHEME || url.path() != SEP7_OPERATION || url.fragment().is_some() {
        return Err(Sep7Error::UnsupportedOperation);
    }

    let mut parameters = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "destination"
                | "amount"
                | "asset_code"
                | "asset_issuer"
                | "network_passphrase"
                | "memo"
                | "memo_type"
        ) {
            return Err(Sep7Error::UnsupportedParameter(key.into_owned()));
        }
        if parameters
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(Sep7Error::DuplicateParameter);
        }
    }

    let destination = StellarAddress::new(required(&parameters, "destination")?)?;
    let amount = UsdcMinorUnits::from_stellar_decimal(required(&parameters, "amount")?)?;
    profile.validate_amount(amount)?;

    let asset_code = required(&parameters, "asset_code")?;
    if asset_code != profile.asset().code() {
        return Err(Sep7Error::WrongAssetCode);
    }
    let asset_issuer = StellarAddress::new_account(required(&parameters, "asset_issuer")?)?;
    if &asset_issuer != profile.asset().issuer() {
        return Err(Sep7Error::WrongAssetIssuer);
    }
    let network_passphrase = required(&parameters, "network_passphrase")?;
    if network_passphrase != profile.network().passphrase() {
        return Err(Sep7Error::WrongNetwork);
    }

    let memo = parameters.get("memo").cloned();
    let memo_type = parameters.get("memo_type").cloned();
    if memo.is_some() != memo_type.is_some() {
        return Err(Sep7Error::IncompleteMemo);
    }
    if let Some(kind) = &memo_type
        && !matches!(
            kind.as_str(),
            "MEMO_TEXT" | "MEMO_ID" | "MEMO_HASH" | "MEMO_RETURN"
        )
    {
        return Err(Sep7Error::UnsupportedMemoType);
    }

    Ok(Sep7Payment {
        destination,
        amount,
        asset_code: asset_code.to_owned(),
        asset_issuer,
        network_passphrase: network_passphrase.to_owned(),
        memo,
        memo_type,
    })
}

fn required<'a>(
    parameters: &'a BTreeMap<String, String>,
    name: &'static str,
) -> Result<&'a str, Sep7Error> {
    parameters
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(Sep7Error::MissingParameter(name))
}

#[derive(Debug, Error)]
pub enum Sep7Error {
    #[error("invalid SEP-0007 URI")]
    InvalidUri(#[source] url::ParseError),
    #[error("only web+stellar:pay requests without fragments are supported")]
    UnsupportedOperation,
    #[error("unsupported SEP-0007 parameter: {0}")]
    UnsupportedParameter(String),
    #[error("SEP-0007 parameters must not be repeated")]
    DuplicateParameter,
    #[error("missing required SEP-0007 parameter: {0}")]
    MissingParameter(&'static str),
    #[error("SEP-0007 asset code does not match the configured asset")]
    WrongAssetCode,
    #[error("SEP-0007 asset issuer does not match the configured issuer")]
    WrongAssetIssuer,
    #[error("SEP-0007 network passphrase does not match the configured network")]
    WrongNetwork,
    #[error("memo and memo_type must be supplied together")]
    IncompleteMemo,
    #[error("unsupported Stellar memo type")]
    UnsupportedMemoType,
    #[error(transparent)]
    InvalidValue(#[from] ValueError),
    #[error(transparent)]
    InvalidProfile(#[from] ProfileError),
}

#[cfg(test)]
mod tests {
    use crate::{QuoteReference, StellarProfile, UsdcMinorUnits};

    use super::{build_deposit_request, parse_payment_request};

    const DESTINATION: &str = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";

    #[test]
    fn deposit_request_round_trips_deterministically() {
        let profile = StellarProfile::testnet_usdc(DESTINATION).expect("valid profile");
        let quote = QuoteReference::new("550e8400-e29b-41d4-a716-446655440000")
            .expect("valid quote reference");
        let request = build_deposit_request(
            &profile,
            &quote,
            UsdcMinorUnits::new(1_234).expect("positive amount"),
        )
        .expect("request can be built");

        assert_eq!(
            parse_payment_request(&profile, &request.to_uri()).expect("request parses"),
            request
        );
    }
}
