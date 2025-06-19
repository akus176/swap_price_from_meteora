import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import { getMint } from "@solana/spl-token";
import fetch from "node-fetch";
import BN from "bn.js";
import BigNumber from "bignumber.js";
import fs from "fs";

import { SOL_MINT, API_URL, connection } from "./CONSTANTS";
import { displayNames } from "./CONSTANTS";

interface PoolData {
  pool_address: string;
  token_a_mint: string;
  token_b_mint: string;
  token_a_amount: string;
  token_b_amount: string;
  tvl: string;
  fee_bps: number;
  token_a_symbol?: string;
  token_b_symbol?: string;
  pool_price?: string;
}

export class SwapPriceTracker {
  private connection: Connection;
  private cpAmm: CpAmm;
  private tokenAddress: PublicKey;

  constructor(tokenAddress: PublicKey) {
    this.connection = connection;
    this.cpAmm = new CpAmm(this.connection);
    this.tokenAddress = tokenAddress;
  }

  private async fetchSolTokenPools(): Promise<PoolData[]> {
    const matchedPools: PoolData[] = [];
    const seenPoolIds = new Set<string>();

    for (const field of ["token_a_mint", "token_b_mint"]) {
      let offset = 0;
      while (true) {
        try {
          const params = new URLSearchParams({
            limit: "50",
            offset: offset.toString(),
            order_by: "tvl",
            order: "desc",
            [field]: this.tokenAddress.toBase58(),
            timestamp: Date.now().toString(),
          });

          const response = await fetch(`${API_URL}?${params.toString()}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const { data: pools } = await response.json() as { data: PoolData[] };
          if (pools.length === 0) break;

          for (const pool of pools) {
            const poolId = pool.pool_address;
            if (!seenPoolIds.has(poolId) &&
              [pool.token_a_mint, pool.token_b_mint].includes(SOL_MINT.toBase58())) {
              seenPoolIds.add(poolId);
              matchedPools.push(pool);
            }
          }

          offset += 50;
        } catch (error) {
          console.error("Error fetching pools:", error);
          break;
        }
      }
    }

    return matchedPools;
  }

  private findHighestTvlPool(pools: PoolData[]): PoolData | null {
    return pools.length > 0 ? pools.reduce((max, curr) =>
      parseFloat(curr.tvl || "0") > parseFloat(max.tvl || "0") ? curr : max
    ) : null;
  }

  async getRealtimeSwapPrice(): Promise<Record<string, any>> {
    const pools = await this.fetchSolTokenPools();
    const pool = this.findHighestTvlPool(pools);
    if (!pool) return { error: "No SOL-token pool found." };

    const poolState = await this.cpAmm.fetchPoolState(new PublicKey(pool.pool_address));
    if (!poolState || Object.keys(poolState).length === 0) {
      return { error: "Failed to fetch or parse valid pool state." };
    }

    // Determine which token is output
    const isSolOutput = pool.token_a_mint !== SOL_MINT.toBase58();

    const [inputMint, outputMint] = await Promise.all([
      getMint(this.connection, SOL_MINT),
      getMint(this.connection, new PublicKey(isSolOutput ? pool.token_a_mint : pool.token_b_mint))
    ]);

    const quote = await this.cpAmm.getQuote({
      inAmount: new BN(1_000_000_000), // 1 SOL in lamports
      inputTokenMint: SOL_MINT,
      inputTokenInfo: {
        mint: inputMint,
        currentEpoch: (await this.connection.getEpochInfo()).epoch
      },
      outputTokenInfo: {
        mint: outputMint,
        currentEpoch: (await this.connection.getEpochInfo()).epoch
      },
      slippage: 0.5,
      poolState,
      currentSlot: await this.connection.getSlot(),
      currentTime: Math.floor(Date.now() / 1000),
    });

    const amountOut = new BigNumber(quote.swapOutAmount.toString()).dividedBy(
      new BigNumber(10).pow(outputMint.decimals)
    );

    const feeMint = isSolOutput ? inputMint : outputMint;
    const fee = new BigNumber(quote.totalFee.toString()).dividedBy(
      new BigNumber(10).pow(feeMint.decimals)
    );

    // Get mint info for token A and token B 
    const [tokenAMint, tokenBMint] = await Promise.all([
      getMint(this.connection, new PublicKey(pool.token_a_mint)),
      getMint(this.connection, new PublicKey(pool.token_b_mint))
    ]);

    const rawPrice = getPriceFromSqrtPrice(
      poolState.sqrtPrice,
      tokenAMint.decimals,
      tokenBMint.decimals
    );

    let finalPrice: BigNumber;
    if (this.tokenAddress.toBase58() === pool.token_a_mint) {
      finalPrice = new BigNumber(1).dividedBy(rawPrice);
    } else {
      finalPrice = new BigNumber(rawPrice);
    }

    return {
      pool_address: pool.pool_address,
      amount_out_for_1_SOL: amountOut.toFixed(6),
      total_tvl: parseFloat(pool.tvl || "0").toFixed(2),
      token_symbol: this.tokenAddress.toBase58() === pool.token_a_mint ? pool.token_a_symbol : pool.token_b_symbol,
      token_address: this.tokenAddress.toBase58(),
      // price_from_sqrt_price: finalPrice.toFixed(9),
      // fee: fee.toFixed(3),
      // price_impact: quote.priceImpact.toFixed(3),
    };
  }

  printFormattedResult(result: Record<string, any>) {
    for (const key in result) {
      if (result.hasOwnProperty(key)) {
        const displayName = displayNames[key] || key;
        console.log(`${displayName}: ${result[key]}`);
      }
    }
    console.log(`\n\n`);
  }

  saveFormattedResultToJson(result: Record<string, any>, filename: string) {
    const formatted: Record<string, any> = {};

    for (const key in result) {
      if (result.hasOwnProperty(key)) {
        const displayKey = displayNames[key] || key;
        formatted[displayKey] = result[key];
      }
    }

    let dataArray: Record<string, any>[] = [];

    if (fs.existsSync(filename)) {
      try {
        const content = fs.readFileSync(filename, "utf-8");
        dataArray = JSON.parse(content);
        if (!Array.isArray(dataArray)) dataArray = [];
      } catch {
        dataArray = [];
      }
    }

    dataArray.push({ timestamp: new Date().toISOString(), ...formatted });

    fs.writeFileSync(filename, JSON.stringify(dataArray, null, 2), "utf-8");
  }
}
