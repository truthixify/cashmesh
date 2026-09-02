use cdk_common::nuts::nut05::{MeltQuoteCustomResponse, QuoteState};
use cdk_common::{Amount, CurrencyUnit, PaymentMethod};

const STELLAR_MELT_QUOTE: &str =
    include_str!("../../../packages/cashu/fixtures/nut05/stellar-melt-quote-unpaid.json");

#[test]
fn stellar_quote_fixture_decodes_with_pinned_cdk_types() {
    let quote: MeltQuoteCustomResponse<String> = serde_json::from_str(STELLAR_MELT_QUOTE)
        .expect("Stellar quote fixture should decode with pinned CDK types");

    assert_eq!(quote.quote, "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f");
    assert_eq!(quote.method, PaymentMethod::Custom("stellar".to_owned()));
    assert_eq!(quote.amount, Amount::from(1_234));
    assert_eq!(quote.fee_reserve, Some(Amount::ZERO));
    assert_eq!(quote.state, QuoteState::Unpaid);
    assert_eq!(quote.expiry, 1_788_300_600);
    assert_eq!(quote.unit, Some(CurrencyUnit::custom("usdc")));
    assert_eq!(quote.payment_preimage, None);
    assert_eq!(quote.change, None);
    assert_eq!(
        quote.request.as_deref(),
        Some(
            "web+stellar:pay?destination=GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4&amount=12.34&asset_code=USDC&asset_issuer=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5&memo=Y29ycmVsYXRpb24%3D&memo_type=MEMO_HASH&network_passphrase=Test+SDF+Network+%3B+September+2015"
        )
    );
}
