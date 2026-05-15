import 'dotenv/config';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();

const envMap = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production,
};

const configuration = new Configuration({
  basePath: envMap[env] ?? PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

export function getPlaidProducts() {
  const raw = process.env.PLAID_PRODUCTS || 'transactions';
  return raw.split(',').map((p) => p.trim());
}

export function getPlaidCountryCodes() {
  const raw = process.env.PLAID_COUNTRY_CODES || 'US';
  return raw.split(',').map((c) => c.trim());
}
