import { parseAbi, parseUnits } from "viem";
import { publicClient, walletClient, account } from "./config/configs";

// Contract addresses
const MOCK_ORACLE_ADDRESS = process.env.MOCK_ORACLE_ADDRESS || "";
const NEW_PRICE = process.env.NEW_PRICE || "";

// Mock Chainlink Aggregator ABI
const MOCK_ORACLE_ABI = parseAbi([
  "function setPrice(int256 newPrice) external",
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() external view returns (uint8)",
  "function description() external view returns (string memory)",
  "event PriceUpdated(int256 oldPrice, int256 newPrice)"
]);

async function main() {
  if (!account) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }
  if (!MOCK_ORACLE_ADDRESS) {
    throw new Error("MOCK_ORACLE_ADDRESS environment variable is required");
  }

  console.log("=".repeat(50));
  console.log("Mock Oracle Price Update Tool");
  console.log("=".repeat(50));

  try {
    // Get oracle information
    const [decimals, description, currentRoundData] = await Promise.all([
      publicClient.readContract({
        address: MOCK_ORACLE_ADDRESS as `0x${string}`,
        abi: MOCK_ORACLE_ABI,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: MOCK_ORACLE_ADDRESS as `0x${string}`,
        abi: MOCK_ORACLE_ABI,
        functionName: "description",
      }),
      publicClient.readContract({
        address: MOCK_ORACLE_ADDRESS as `0x${string}`,
        abi: MOCK_ORACLE_ABI,
        functionName: "latestRoundData",
      }),
    ]);

    console.log(`Oracle: ${MOCK_ORACLE_ADDRESS}`);
    console.log(`Description: ${description}`);
    console.log(`Decimals: ${decimals}`);
    console.log(`Current Price: ${currentRoundData[1]} (raw)`);
    console.log(`Current Price: ${Number(currentRoundData[1]) / Math.pow(10, decimals)} (formatted)`);

    // Parse the new price - scale it by the oracle's decimals
    const newPriceScaled = parseUnits(NEW_PRICE, decimals);
    const newPriceBigInt = BigInt(newPriceScaled.toString());

    console.log(`\nUpdating price to: ${NEW_PRICE}`);
    console.log(`Scaled price: ${newPriceBigInt}`);

    // Update the price
    const hash = await walletClient.writeContract({
      address: MOCK_ORACLE_ADDRESS as `0x${string}`,
      abi: MOCK_ORACLE_ABI,
      functionName: "setPrice",
      args: [newPriceBigInt as any], // Cast to handle the int256 type
    });

    console.log(`\nTransaction sent: ${hash}`);
    console.log("Waiting for confirmation...");

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log("✅ Price updated successfully!");
    console.log(`Block number: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);

    // Verify the new price
    const newRoundData = await publicClient.readContract({
      address: MOCK_ORACLE_ADDRESS as `0x${string}`,
      abi: MOCK_ORACLE_ABI,
      functionName: "latestRoundData",
    });

    console.log(`\n=== Verification ===`);
    console.log(`New Price (raw): ${newRoundData[1]}`);
    console.log(`New Price (formatted): ${Number(newRoundData[1]) / Math.pow(10, decimals)}`);
    console.log(`Updated at: ${new Date(Number(newRoundData[3]) * 1000).toISOString()}`);

  } catch (error) {
    console.error("Error updating oracle price:", error);
    
    // Check if it's an authorization error
    if (error instanceof Error && error.message.includes("Not authorized")) {
      console.error("\n❌ Authorization Error: You are not the owner of this oracle contract.");
      console.error("Only the contract owner can update the price.");
    }
  }
}

// Helper function to validate price input
function validatePriceInput(priceStr: string): boolean {
  const price = parseFloat(priceStr);
  return !isNaN(price) && price > 0;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });