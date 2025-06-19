import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import BigNumber from "bignumber.js";
import * as readline from 'readline';

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const API_URL = "https://dlmm-api.meteora.ag/pair/all";
const connection = new Connection("https://api.mainnet-beta.solana.com");

interface PoolData {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x_amount: number;
  reserve_y_amount: number;
  bin_step: number;
  liquidity: string;
  current_price: number;
  mint_x_symbol?: string;
  mint_y_symbol?: string;
}

// Find all pool that match SOL-Token pairs
async function fetchSolTokenPools(tokenAddress: PublicKey): Promise<PoolData[]> {
  const matchedPools: PoolData[] = [];
  const tokenAddressStr = tokenAddress.toBase58().toLowerCase().trim();
  const solAddressStr = SOL_MINT.toBase58().toLowerCase();

  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const allPools: PoolData[] = await response.json();
    console.log(`Scanning ${allPools.length} pools for SOL-Token pairs...`);

    for (const pool of allPools) {
      const mintX = pool.mint_x.toLowerCase().trim();
      const mintY = pool.mint_y.toLowerCase().trim();
      const liquidity = parseFloat(pool.liquidity || "0");

      const isSolToToken = (mintX === solAddressStr && mintY === tokenAddressStr) ||
                          (mintY === solAddressStr && mintX === tokenAddressStr);
      const hasLiquidity = liquidity > 0;
      const hasReserves = pool.reserve_x_amount > 0 && pool.reserve_y_amount > 0;

      if (isSolToToken && hasLiquidity && hasReserves) {
        matchedPools.push(pool);
      }
    }

    console.log(`Found ${matchedPools.length} usable SOL-Token pools`);
    return matchedPools;
  } catch (error) {
    console.error("Error fetching pools:", error);
    return [];
  }
}

// Find the pool with the highest liquidity
function findHighestLiquidityPool(pools: PoolData[]): PoolData | null {
  if (pools.length === 0) return null;
  
  const sortedPools = pools.sort((a, b) => {
    const liquidityA = parseFloat(a.liquidity || "0");
    const liquidityB = parseFloat(b.liquidity || "0");
    return liquidityB - liquidityA;
  });
  
  return sortedPools[0];
}

// Parse the token symbol from the pool name
function parseTokenSymbol(poolName: string): string {
  const parts = poolName.split('-');
  if (parts.length >= 2) {
    return parts.find(part => part.toUpperCase() !== 'SOL') || 'UNKNOWN';
  }
  return 'UNKNOWN';
}

// Get real-time swap price for SOL-Token pairs
async function getRealtimeSwapPrice(tokenAddress: PublicKey): Promise<any> {
  const pools = await fetchSolTokenPools(tokenAddress);
  const pool = findHighestLiquidityPool(pools);
  if (!pool) return { error: "No DLMM SOL-token pool found." };

  try {
    const pairAddress = new PublicKey(pool.address);
    const dlmmPool = await DLMM.create(connection, pairAddress);

    const [mintX, mintY] = await Promise.all([
      getMint(connection, new PublicKey(pool.mint_x)),
      getMint(connection, new PublicKey(pool.mint_y))
    ]);

    const solIsMintX = pool.mint_x.toLowerCase().trim() === SOL_MINT.toBase58().toLowerCase();
    const tokenMint = solIsMintX ? mintY : mintX;
    const tokenSymbol = solIsMintX ? pool.mint_y_symbol : pool.mint_x_symbol;

    const swapAmount = new BN(1 * 10 ** 9); 
    const swapYtoX = solIsMintX ? false : true;

    let realTimePrice = null;
    let activeBinId = null;

    try {
      const poolState = dlmmPool.lbPair;
      if (poolState && poolState.activeId !== undefined) {
        activeBinId = poolState.activeId;
        const binStep = poolState.binStep;

        const priceOfYinX = new BigNumber(Math.pow(1 + binStep / 10000, activeBinId))
          .multipliedBy(new BigNumber(10).pow(mintX.decimals - mintY.decimals));

        if (solIsMintX) {
          realTimePrice = priceOfYinX.toNumber();
        } else {
          if (!priceOfYinX.isZero()) {
            realTimePrice = new BigNumber(1).dividedBy(priceOfYinX).toNumber();
          }
        }
      }
    } catch (priceError) {
      if (priceError instanceof Error) {
        console.log("Could not calculate real-time price:", priceError.message);
      } else {
        console.log("Could not calculate real-time price:", priceError);
      }
    }

    const binArrays = await dlmmPool.getBinArrayForSwap(swapYtoX);
    const swapQuote = await dlmmPool.swapQuote(swapAmount, swapYtoX, new BN(1), binArrays);

    const solDecimals = 9;
    const tokenDecimals = tokenMint.decimals;

    let tokenAmountOut: BigNumber;
    let solAmountIn: BigNumber;

    if (solIsMintX) {
      tokenAmountOut = new BigNumber(swapQuote.minOutAmount.toString()).dividedBy(
        new BigNumber(10).pow(tokenDecimals)
      );
      solAmountIn = new BigNumber(swapAmount.toString()).dividedBy(
        new BigNumber(10).pow(solDecimals)
      );
    } else {
      tokenAmountOut = new BigNumber(swapQuote.minOutAmount.toString()).dividedBy(
        new BigNumber(10).pow(tokenDecimals)
      );
      solAmountIn = new BigNumber(swapAmount.toString()).dividedBy(
        new BigNumber(10).pow(solDecimals)
      );
    }

    const feeInSol = new BigNumber(swapQuote.fee.toString()).dividedBy(
      new BigNumber(10).pow(solDecimals)
    );

    const tokensPerSol = tokenAmountOut.dividedBy(solAmountIn);

    return {
      "Pool address": pool.address,
      "Price": realTimePrice ? parseFloat(realTimePrice.toFixed(6)) : null,
      "TVL": parseFloat(pool.liquidity || "0"),
      "Symbol name": parseTokenSymbol(pool.name),
      "MintB": tokenAddress.toBase58()
    };
  } catch (error: any) {
    console.error("Swap calculation failed:", error.message);
    return { error: `Swap calculation failed: ${error.message}` };
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const tokenAddressInput = await new Promise<string>(resolve => {
    rl.question("Enter token mint address: ", answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!tokenAddressInput) {
    console.error("No token address provided. Exiting.");
    return;
  }

  console.log("Waiting for fetching data");

  try {
    const tokenAddress = new PublicKey(tokenAddressInput);

    while (true) {
      const result = await getRealtimeSwapPrice(tokenAddress);
      console.clear();
      console.log(`[${new Date().toLocaleTimeString()}] SOL → Token Swap Info:`);
      console.log(JSON.stringify(result, null, 2));
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

main().catch(console.error);