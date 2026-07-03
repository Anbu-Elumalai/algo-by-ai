# Production Deployment Manual

This document details the step-by-step production pre-flight checks and setup.

## 1. Secrets Setup (Vault/AWS)

The production configuration requires secrets to be fetched from HashiCorp Vault or AWS Secrets Manager. If local environment variables are used, they must be set in the system daemon.

Required variables:
* `JWT_SECRET`: Must be a secure 32-character (256-bit strength) string.
* `MONGO_URI`: MongoDB connection URI.
* `UPSTOX_API_KEY`: Upstox Developer API Key.
* `UPSTOX_API_SECRET`: Upstox Developer API Secret.
* `UPSTOX_ACCESS_TOKEN`: Valid OAuth Access Token.

## 2. Startup Verification
The system validates the presence of required environment parameters and checks the JWT secret length on boot.

If configuration errors exist, the server fails fast with:
```
❌ CRITICAL BOOT CONFIG ERROR: ...
```
or
```
❌ CRITICAL SECURITY BREACH: JWT_SECRET must be at least 32 characters (256-bit strength)!
```

## 3. Pre-flight Verification Script
Always execute the strategy certification script before enabling live trading mode:
```bash
npx ts-node src/scripts/master_certification.ts
```
This script confirms:
* 100% Backtest-Live Parity
* Absence of Look-Ahead Bias
* Price Engine Feed Integrity
