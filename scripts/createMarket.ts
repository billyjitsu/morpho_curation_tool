import { parseAbi, decodeEventLog, Log } from "viem";
import { publicClient, walletClient } from "./config/configs"
import MORPHO_ABI from './abis/morpho.json';

// Contract addresses
const MORPHO_ADDRESS = process.env.MORPHO_ADDRESS || "";
const LOANTOKEN_ADDRESS = process.env.LOANTOKEN_ADDRESS || "";
const COLLATERALTOKEN_ADDRESS = process.env.COLLATERALTOKEN_ADDRESS || "";
const MORPHO_ORACLE_ADDRESS = process.env.MORPHO_ORACLE_ADDRESS || "";
const IRM_ADDRESS = process.env.IRM_ADDRESS || "";
const LLTV = process.env.LLTV ? BigInt(process.env.LLTV) : 0n;

// Define the MarketParams struct as a TypeScript type
type MarketParams = [
  loanToken: `0x${string}`,
  collateralToken: `0x${string}`,
  oracle: `0x${string}`,
  irm: `0x${string}`,
  lltv: bigint
];

// Function to find the market ID from logs
function findMarketIdFromLogs(logs: any[]): string | null {
  // Look for the CreateMarket event log (first log entry)
  const createMarketLog = logs[0];
  
  if (createMarketLog && createMarketLog.topics && createMarketLog.topics.length > 1) {
    // MarketId is stored in topics[1]
    return createMarketLog.topics[1];
  }

  return null;
}

async function waitForMarketCreation(receipt: any, maxAttempts = 10, intervalMs = 3000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      
      if (receipt.logs && receipt.logs.length > 0) {
        const marketId = findMarketIdFromLogs(receipt.logs);
        
        if (marketId) {
          clearInterval(interval);
          console.log("\n✅ Market created successfully!");
          console.log("Add this to your MARKET_ID in your .env file:");
          console.log(`MARKET_ID: ${marketId}`);
          
          try {
            const marketParamsFromContract = await publicClient.readContract({
              address: MORPHO_ADDRESS as `0x${string}`,
              abi: parseAbi(["function idToMarketParams(bytes32) view returns (address, address, address, address, uint256)"]),
              functionName: "idToMarketParams",
              args: [marketId as `0x${string}`]
            });
            
            console.log("\nMarket created with the following parameters:");
            console.log(`Loan Token: ${marketParamsFromContract[0]}`);
            console.log(`Collateral Token: ${marketParamsFromContract[1]}`);
            console.log(`Oracle: ${marketParamsFromContract[2]}`);
            console.log(`IRM: ${marketParamsFromContract[3]}`);
            console.log(`LLTV: ${marketParamsFromContract[4]}`);
          } catch (error) {
            console.log("Could not fetch market parameters from contract.");
          }
          resolve(marketId);
          return;
        }
      }
      
      console.log(`Checking for market creation... (attempt ${attempts}/${maxAttempts})`);
      
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        console.log("⚠️ Market created but couldn't extract market ID from logs after multiple attempts.");
        resolve(null);
      }
    }, intervalMs);
  });
}

async function main() {

  // Market parameters as a tuple (in the correct order)
  const marketParams: MarketParams = [
    LOANTOKEN_ADDRESS as `0x${string}`,
    COLLATERALTOKEN_ADDRESS as `0x${string}`,
    MORPHO_ORACLE_ADDRESS as `0x${string}`,
    IRM_ADDRESS as `0x${string}`,
    LLTV
  ];

  console.log("Creating market with parameters:");
  console.log(`Loan Token: ${marketParams[0]}`);
  console.log(`Collateral Token: ${marketParams[1]}`);
  console.log(`Oracle: ${marketParams[2]}`);
  console.log(`IRM: ${marketParams[3]}`);
  console.log(`LLTV: ${marketParams[4].toString()}`);

  try {
    const hash = await walletClient.writeContract({
      address: MORPHO_ADDRESS as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "createMarket",
      args: [marketParams],
    });

    // console.log("Transaction sent! Waiting for confirmation...");
    console.log(`Transaction hash: ${hash}`);

    // Wait for transaction
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // console.log("Transaction confirmed!");
    console.log(`Block number: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);

    // Extract market ID from logs
    let marketId: string | null = null;

    if (receipt.logs && receipt.logs.length > 0) {
      console.log("Transaction logs found. Searching for CreateMarket event...");
      marketId = await waitForMarketCreation(receipt);
    }

    // If marketId is found, print it
    if (marketId) {
      console.log("\n✅ Market created successfully!");
      console.log("Add this to your MARKET_ID in your .env file:");
      console.log(`MARKET_ID: ${marketId}`);
      
      // Get market details to verify
      try {
        const marketParamsFromContract = await publicClient.readContract({
          address: MORPHO_ADDRESS as `0x${string}`,
          abi: parseAbi(["function idToMarketParams(bytes32) view returns (address, address, address, address, uint256)"]),
          functionName: "idToMarketParams",
          args: [marketId as `0x${string}`]
        });
        
        console.log("\nMarket created with the following parameters:");
        console.log(`Loan Token: ${marketParamsFromContract[0]}`);
        console.log(`Collateral Token: ${marketParamsFromContract[1]}`);
        console.log(`Oracle: ${marketParamsFromContract[2]}`);
        console.log(`IRM: ${marketParamsFromContract[3]}`);
        console.log(`LLTV: ${marketParamsFromContract[4]}`);
      } catch (error) {
        console.log("Could not fetch market parameters from contract.");
      }
    } else {
      console.log("⚠️ Market created but couldn't extract market ID from logs.");
    }

  } catch (error) {
    console.error("Error creating market:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });