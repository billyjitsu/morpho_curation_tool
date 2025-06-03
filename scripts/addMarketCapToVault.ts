import { publicClient, walletClient } from "./config/configs";
import VAULT_ABI from "./abis/vault.json";

let vaultAddress = process.env.VAULT_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";

// Market parameters - these should match what was used in addMarketToVault
const MARKET_PARAMS = {
  loanToken: process.env.LOANTOKEN_ADDRESS || "", 
  collateralToken: process.env.COLLATERALTOKEN_ADDRESS || "",
  oracle: process.env.MORPHO_ORACLE_ADDRESS || "",
  irm: process.env.IRM_ADDRESS || "",
  lltv: process.env.LLTV ? BigInt(process.env.LLTV) : 860000000000000000n // 0.86 as default LLTV
};

async function checkPendingCapStatus(vaultAddress: string, marketId: string) {
  try {
    const pendingCapInfo = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "pendingCap",
      args: [marketId as `0x${string}`]
    });

    const pendingCapValue = pendingCapInfo[0];
    const validAtTimestamp = Number(pendingCapInfo[1]);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const timeUntilValid = validAtTimestamp - currentTimestamp;

    console.log("\n======= Pending Cap Status =======");
    console.log("Market ID:", marketId);
    console.log("Pending Cap Value:", pendingCapValue.toString());
    console.log("Valid At (timestamp):", validAtTimestamp);
    
    // Check if there's no pending cap (value is 0 and validAt is 0)
    if (pendingCapValue === 0n && validAtTimestamp === 0) {
      console.log("❌ No pending cap found for this market.");
      console.log("==================================\n");
      return { hasPendingCap: false, isReady: false, timeUntilValid: 0 };
    }

    // Check if timelock has passed
    if (timeUntilValid > 0) {
      const hours = Math.floor(timeUntilValid / 3600);
      const minutes = Math.floor((timeUntilValid % 3600) / 60);
      const seconds = timeUntilValid % 60;
      console.log(`⏳ Time until cap can be accepted: ${hours}h ${minutes}m ${seconds}s`);
      
      const acceptDate = new Date(validAtTimestamp * 1000);
      console.log(`Cap will be ready for acceptance at: ${acceptDate.toLocaleString()}`);
      console.log("==================================\n");
      return { hasPendingCap: true, isReady: false, timeUntilValid };
    } else {
      console.log("✅ Cap is READY to be accepted now!");
      console.log("==================================\n");
      return { hasPendingCap: true, isReady: true, timeUntilValid: 0 };
    }
  } catch (error) {
    console.error("Error checking pending cap status:", error);
    return { hasPendingCap: false, isReady: false, timeUntilValid: 0 };
  }
}

async function acceptCap() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it with --vault=0x... or in VAULT_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with --marketId=0x...");
  }
  if (!MARKET_PARAMS.collateralToken || !MARKET_PARAMS.oracle || !MARKET_PARAMS.irm) {
    throw new Error("All market parameters (COLLATERALTOKEN_ADDRESS, MORPHO_ORACLE_ADDRESS, IRM_ADDRESS) are required in environment variables.");
  }

  try {
    console.log("Checking market status...");
    
    // First, check if the market is already enabled
    const marketConfig = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "config",
      args: [marketId as `0x${string}`]
    });

    if (marketConfig[1]) { // If enabled is true
      console.log("✅ Market is already enabled with cap:", marketConfig[0].toString());
      console.log("No action needed - market is already active.");
      return;
    }

    // Check pending cap status
    const pendingStatus = await checkPendingCapStatus(vaultAddress, marketId);
    
    if (!pendingStatus.hasPendingCap) {
      console.log("❌ No pending cap found for this market.");
      console.log("Please run the addMarketToVault script first to submit a cap.");
      return;
    }

    if (!pendingStatus.isReady) {
      const hours = Math.floor(pendingStatus.timeUntilValid / 3600);
      const minutes = Math.floor((pendingStatus.timeUntilValid % 3600) / 60);
      console.log(`❌ Cap is not ready to be accepted yet.`);
      console.log(`Please wait ${hours}h ${minutes}m before trying again.`);
      return;
    }

    // If we get here, the cap is ready to be accepted
    console.log("🚀 Proceeding with cap acceptance...");
    console.log("Using market parameters:");
    console.log("- Loan Token:", MARKET_PARAMS.loanToken);
    console.log("- Collateral Token:", MARKET_PARAMS.collateralToken);
    console.log("- Oracle:", MARKET_PARAMS.oracle);
    console.log("- IRM:", MARKET_PARAMS.irm);
    console.log("- LLTV:", MARKET_PARAMS.lltv.toString());

    // Format market parameters for contract call
    const marketParamsTuple = [
      MARKET_PARAMS.loanToken as `0x${string}`,
      MARKET_PARAMS.collateralToken as `0x${string}`,
      MARKET_PARAMS.oracle as `0x${string}`,
      MARKET_PARAMS.irm as `0x${string}`,
      MARKET_PARAMS.lltv
    ];

    // Accept the cap
    const hash = await walletClient.writeContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "acceptCap",
      args: [marketParamsTuple]
    });

    console.log("Transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    console.log("✅ Cap accepted successfully!");
    console.log("Transaction hash:", receipt.transactionHash);

    // Check the new market config after acceptance
    const newMarketConfig = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "config",
      args: [marketId as `0x${string}`]
    });

    console.log("\n======= Market Config After Acceptance =======");
    console.log("Cap:", newMarketConfig[0].toString());
    console.log("Enabled:", newMarketConfig[1]);
    console.log("Removable At:", newMarketConfig[2].toString());
    console.log("==============================================");

    console.log("\n🎉 Market successfully added to vault!");
    console.log("Next step: Configure supply and withdraw queues with this market ID.");

  } catch (error) {
    console.error("❌ Error during cap acceptance:", error);
    
    // Provide helpful error messages for common issues
    if (error instanceof Error) {
      if (error.message.includes("execution reverted")) {
        console.log("\n💡 Possible reasons for failure:");
        console.log("- Timelock period hasn't passed yet");
        console.log("- Market parameters don't match the submitted cap");
        console.log("- No pending cap exists for this market");
        console.log("- Transaction was frontrun or cap was already accepted");
      }
    }
    
    throw error;
  }
}

// Main execution with better error handling
async function main() {
  try {
    await acceptCap();
    console.log("\n✅ Script completed successfully!");
  } catch (error) {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  }
}

main();