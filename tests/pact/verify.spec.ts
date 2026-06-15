import { describe, test } from 'vitest';
import { Verifier } from '@pact-foundation/pact';

const PACT_BROKER_URL = process.env.PACT_BROKER_URL || 'http://192.168.68.69:9292';
const PACT_BROKER_USERNAME = process.env.PACT_BROKER_USERNAME || 'silver';
const PACT_BROKER_PASSWORD = process.env.PACT_BROKER_PASSWORD || '135789';

describe('Pact Verification', () => {
  test('complies with consumer contracts', async () => {
    const opts = {
      provider: 'WWVDataEngine',
      providerBaseUrl: 'http://127.0.0.1:5000',
      pactBrokerUrl: PACT_BROKER_URL,
      pactBrokerUsername: PACT_BROKER_USERNAME,
      pactBrokerPassword: PACT_BROKER_PASSWORD,
      publishVerificationResult: true,
      providerVersion: process.env.GITHUB_SHA || '1.0.0',
      consumerVersionSelectors: [
        { matchingBranch: true, latest: true },
      ],
    };

    return new Verifier(opts).verifyProvider();
  }, 60000);
});
