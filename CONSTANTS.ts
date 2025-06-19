// Constants used for implementing core source code

import { Connection, PublicKey } from "@solana/web3.js";

export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const API_URL = "https://dammv2-api.meteora.ag/pools";
export const connection = new Connection("https://api.mainnet-beta.solana.com");

export const displayNames: Record<string, string> = {
  token_address: "MintB",
  token_symbol: "Symbol name",
  pool_address: "Pool address",
  total_tvl: "TVL",
  amount_out_for_1_SOL: "Price",
  fee: "Paid to Liquidity Provider",
  price_from_sqrt_price: "Current Pool Price",
  price_impact: "Price Impact"
};