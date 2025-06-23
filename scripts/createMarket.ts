import { parseAbi, decodeEventLog, Log } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs"
import MORPHO_ABI from './abis/morpho.json';

const walletClient = createWalletByIndex(0);

// Contract addresses
const MORPHO_ADDRESS = process.env.MORPHO_ADDRESS || "";
const LOANTOKEN_ADDRESS = process.env.LOANTOKEN_ADDRESS || "";
const COLLATERALTOKEN_ADDRESS = process.env.COLLATERALTOKEN_ADDRESS || "";
const MORPHO_ORACLE_ADDRESS = process.env.MORPHO_ORACLE_ADDRESS || "";
const IRM_ADDRESS = process.env.IRM_ADDRESS || "";
const LLTV = process.env.LLTV ? BigInt(process.env.LLTV) : 0n;

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

// Define the MarketParams struct as a TypeScript type
type MarketParams = [
  loanToken: `0x${string}`,
  collateralToken: `0x${string}`,
  oracle: `0x${string}`,
  irm: `0x${string}`,
  lltv: bigint
];

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// Enhanced function to get market ID with retry logic
async function getMarketIdFromLogs(blockNumber: bigint, retries = MAX_RETRIES): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempting to get market ID from logs (attempt ${attempt}/${retries})...`);
      
      // Try to get logs from the specific block
      const logs = await publicClient.getLogs({
        address: MORPHO_ADDRESS as `0x${string}`,
        event: parseAbi([
          "event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)"
        ])[0],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      });

      if (logs.length > 0 && logs[0].topics && logs[0].topics.length > 1) {
        const marketId = logs[0].topics[1];
        console.log(`✅ Market ID found: ${marketId}`);
        return marketId;
      }
      
      if (attempt < retries) {
        console.log(`No logs found, waiting ${RETRY_DELAY/1000} seconds before retry...`);
        await sleep(RETRY_DELAY);
      }
    } catch (error) {
      console.log(`Error getting logs on attempt ${attempt}:`, error);
      if (attempt < retries) {
        console.log(`Waiting ${RETRY_DELAY/1000} seconds before retry...`);
        await sleep(RETRY_DELAY);
      }
    }
  }
  
  return null;
}

// Fallback function to extract market ID from receipt logs (original method)
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

// Function to verify market creation and display details
async function verifyMarketCreation(marketId: string): Promise<void> {
  try {
    const marketParamsFromContract = await publicClient.readContract({
      address: MORPHO_ADDRESS as `0x${string}`,
      abi: parseAbi(["function idToMarketParams(bytes32) view returns (address, address, address, address, uint256)"]),
      functionName: "idToMarketParams",
      args: [marketId as `0x${string}`]
    });
    
    console.log("\n✅ Market verified successfully!");
    console.log("Market created with the following parameters:");
    console.log(`Loan Token: ${marketParamsFromContract[0]}`);
    console.log(`Collateral Token: ${marketParamsFromContract[1]}`);
    console.log(`Oracle: ${marketParamsFromContract[2]}`);
    console.log(`IRM: ${marketParamsFromContract[3]}`);
    console.log(`LLTV: ${marketParamsFromContract[4]}`);
  } catch (error) {
    console.log("⚠️ Could not fetch market parameters from contract for verification.");
    console.error("Error:", error);
  }
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

    console.log(`Transaction hash: ${hash}`);

    // Wait for transaction
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log(`Block number: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);

    // Try to extract market ID using the enhanced retry method first
    console.log("Checking transaction logs for the new market ID...");
    let marketId = await getMarketIdFromLogs(receipt.blockNumber);

    // If the enhanced method fails, fall back to the original method
    if (!marketId && receipt.logs && receipt.logs.length > 0) {
      console.log("Enhanced method failed, trying fallback method...");
      marketId = await waitForMarketCreation(receipt) as string | null;
    }

    // If marketId is found, print it and verify
    if (marketId) {
      console.log("\n✅ Market created successfully!");
      console.log("Add this to your MARKET_ID in your .env file:");
      console.log(`MARKET_ID: ${marketId}`);
      
      // Verify market creation
      await verifyMarketCreation(marketId);
    } else {
      console.log("⚠️ Market created but couldn't extract market ID from logs after multiple attempts.");
      console.log("Check the transaction on the block explorer to find the market ID.");
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