# Deployment Summary

**Last Updated:** 2026-02-15
**Network:** Sei Mainnet (Chain ID: 1329)
**Deployer:** 0x1eadf3406c46b516c100c33abd33b7d8006e2da5

---

## Current Deployment

**Date:** 2026-02-15
**Status:** Production (Ready to Deploy)

### Deployed Addresses

| Contract | Address |
|----------|---------|
| MockUSDC | `0xad1e5b9cc88da1fb2319e38958edabcbf597ff0d` |
| SaySoToken | `0x136815fbf6a8d097465c91c9ab25872807d17371` |
| SaySoForwarder | `0xf920aaf29cae064fe2a47069cb86f9357ac65b9b` |
| ResolutionOracle | `0xc7ec37ac0654a7c85ce860d9e875a07dc2d636b4` |
| MarketFactory | `0x3c32f754a5b0ed4f0880c6f37021750ed742dd78` |

### Key Features

- **LMSR Bonding Curve:** Logarithmic Market Scoring Rule for automated market making with proper slippage
- **Atomic Market Seeding:** Single transaction for market creation with initial liquidity
- **Gasless Trading:** ERC-2771 meta-transactions via SaySoForwarder
- **USDC Permit:** ERC-2612 gasless approvals
- **Internal Accounting:** Prevents donation attacks and resolve timing manipulation
- **Oracle Validation:** Markets validated via factory registry
- **Flash Loan Protection:** 10-block minimum hold period
- **Minimum Deposits:** 1 USDC per trade, 10 USDC seed minimum

### Gas Costs

- MarketFactory deployment: 0.04004752 SEI (~$0.02)
- Typical market creation: ~0.02 SEI

---

### Files Ready for Deployment

- All contracts updated and tested
- Deployment script: `scripts/deploy-all.ts`
- Test suite: 183/183 passing (100%)
- Documentation: ARCHITECTURE.md, TESTING.md, CHANGELOG.md

### Deployment Checklist

- [ ] Deploy new contracts to Sei mainnet
- [ ] Update API with new addresses and ABIs
- [ ] Update frontend with new contract addresses

---

## Verification Commands

### Check Current Deployment

```bash
# Verify factory contract
npx hardhat verify --network sei 0x3c32f754a5b0ed4f0880c6f37021750ed742dd78 \
  "0xaD1E5b9Cc88Da1Fb2319e38958EDABCbF597ff0D" \
  "0xc7ec37ac0654a7c85ce860d9e875a07dc2d636b4" \
  "0xF920aaF29CAE064fE2a47069Cb86f9357ac65b9B"
```

### Run Tests

```bash
# Contract tests
npm test

# API integration tests
cd sayso-api && npm run test:e2e

# Frontend e2e tests
cd sayso-frontend && npx playwright test
```

---

## Notes

- All contracts are on **Sei mainnet** (no testnet deployments)
- Mock USDC is production-ready but should be replaced with real USDC for public launch
- SAYSO token has open minting (onlyOwner) - secure the owner key
