import { PublicKey } from "@solana/web3.js";
import { SwapPriceTracker } from "./dammv2_swapInfo";

async function main() {
  console.log(`Enter a token mint to view real-time data, or press Ctrl+C to quit.`);
  process.stdout.write("Enter token mint address: ");

  const tokenInput = await new Promise<string>(resolve =>
    process.stdin.once("data", data => resolve(data.toString().trim()))
  );

  try {
    const tokenAddress = new PublicKey(tokenInput);
    const tracker = new SwapPriceTracker(tokenAddress);

    console.log(`\nTracking SOL → ${tokenAddress.toBase58()}...\n`);
    console.log(`Fetching data, please wait a moment...\n`);

    while (true) {
      const result = await tracker.getRealtimeSwapPrice();
      console.log(`[${new Date().toLocaleTimeString()}] Real-time swap info:`);
      tracker.printFormattedResult(result);
      tracker.saveFormattedResultToJson(result, "latest_price.json");

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err: any) {
    console.error("Invalid token address or error:", err.message);
  }
}

main();
