import axios from "axios";

export async function getSecret(key: string, defaultFallback: string = ""): Promise<string> {
  // 1. Try HashiCorp Vault
  if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
    try {
      const response = await axios.get(`${process.env.VAULT_ADDR}/v1/secret/data/trading-bot`, {
        headers: { "X-Vault-Token": process.env.VAULT_TOKEN },
        timeout: 2000
      });
      const secretVal = response.data?.data?.data?.[key] || response.data?.data?.[key];
      if (secretVal) return secretVal;
    } catch (err: any) {
      console.warn(`⚠️ Vault secret query failed for ${key}:`, err.message);
    }
  }

  // 2. Try AWS Secrets Manager (simulated via API/environment checks or standard fallbacks)
  if (process.env.AWS_SECRET_NAME && process.env.AWS_REGION) {
    // If AWS SDK is available or mocked via HTTP local endpoints
    try {
      // In production, fetch via AWS SDK. We'll fallback to environment to keep execution simple.
    } catch (err: any) {
      console.warn(`⚠️ AWS Secrets Manager query failed for ${key}:`, err.message);
    }
  }

  // 3. Environment Fallback
  const secret = process.env[key] || defaultFallback;

  // Strength Check: Enforce 256-bit key (32 bytes/characters) for JWT_SECRET
  if (key === "JWT_SECRET" && secret.length < 32) {
    throw new Error("❌ CRITICAL SECURITY BREACH: JWT_SECRET must be at least 32 characters (256-bit strength)!");
  }

  return secret;
}
