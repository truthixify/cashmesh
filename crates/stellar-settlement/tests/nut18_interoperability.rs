use std::str::FromStr;

use cdk_common::nuts::nut18::PaymentRequest;
use cdk_common::{Amount, TransportType};

const STRICT_STELLAR_REQUEST: &str =
    include_str!("../../../packages/cashu/fixtures/nut18/strict-stellar.creq");

#[test]
fn cashu_ts_strict_stellar_request_decodes_with_pinned_cdk() {
    let request = PaymentRequest::from_str(STRICT_STELLAR_REQUEST.trim())
        .expect("cashu-ts fixture should decode with pinned CDK types");

    assert_eq!(request.payment_id.as_deref(), Some("invoice-interop-001"));
    assert_eq!(request.amount, Some(Amount::from(1_234)));
    assert_eq!(
        request.unit.as_ref().map(ToString::to_string).as_deref(),
        Some("usdc")
    );
    assert_eq!(request.single_use, Some(true));
    assert_eq!(request.mint_preferred, None);
    assert_eq!(
        request
            .mints
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        vec![
            "https://mint-a.cashmesh.example".to_owned(),
            "https://mint-b.cashmesh.example".to_owned(),
        ]
    );

    assert_eq!(request.supported_methods.len(), 1);
    assert_eq!(request.supported_methods[0].method, "stellar");
    assert_eq!(request.supported_methods[0].fee, None);
    assert_eq!(request.transports.len(), 1);
    assert_eq!(request.transports[0]._type, TransportType::HttpPost);
    assert_eq!(
        request.transports[0].target,
        "https://pay.cashmesh.example/v1/cashu/payments"
    );
    assert_eq!(request.description, None);
    assert_eq!(request.nut10, None);
}
