/**
 * auth.js — returns HTTP headers for DecisionVault API requests.
 *
 * Currently uses a static API key from the environment.
 * To swap in OAuth2: replace getAuthHeaders() to fetch/cache a Bearer token
 * and return { Authorization: `Bearer ${token}` } instead.
 *
 * DecisionVault API key format: Authorization: Token {key}
 */

require('dotenv').config();

async function getAuthHeaders() {
  const apiKey = process.env.DV_API_KEY;
  if (!apiKey) {
    throw new Error('DV_API_KEY is not set in the environment');
  }
  return {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

module.exports = { getAuthHeaders };
