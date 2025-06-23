import { keccak256, encodeAbiParameters } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";
import VAULT_ABI from "./abis/vault.json";

const walletClient = createWalletByIndex(0);

// Addresses
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
// Supply cap for the market in the vault (in token units with 18 decimals)
const SUPPLY_CAP = process.env.SUPPLY_CAP ? BigInt(process.env.SUPPLY_CAP) : 1000000000000000000000000n; // 1,000,000 tokens with 18 decimals as default

// Market parameters
const MARKET_PARAMS = {
  loanToken: process.env.LOANTOKEN_ADDRESS || "",
  collateralToken: process.env.COLLATERALTOKEN_ADDRESS || "",
  oracle: process.env.MORPHO_ORACLE_ADDRESS || "",
  irm: process.env.IRM_ADDRESS || "",
  lltv: process.env.LLTV ? BigInt(process.env.LLTV) : 860000000000000000n // 0.86 as default LLTV
};



// Calculate market ID from market parameters
function calculateMarketId(params: typeof MARKET_PARAMS): `0x${string}` {
  // Create a tuple array for the parameters
  const paramsTuple = [
    params.loanToken as `0x${string}`,
    params.collateralToken as `0x${string}`,
    params.oracle as `0x${string}`,
    params.irm as `0x${string}`,
    params.lltv
  ];

  return keccak256(
    encodeAbiParameters(
      [
        { 
          type: 'tuple', 
          components: [
            { name: 'loanToken', type: 'address' },
            { name: 'collateralToken', type: 'address' },
            { name: 'oracle', type: 'address' },
            { name: 'irm', type: 'address' },
            { name: 'lltv', type: 'uint256' }
          ] 
        }
      ],
      [paramsTuple] // Pass as an array containing the tuple
    )
  );
}

async function addMarketToVault() {
  if (!VAULT_ADDRESS) {
    throw new Error("VAULT_ADDRESS environment variable is required. Set it to your vault address.");
  }
  if (!MARKET_PARAMS.collateralToken || !MARKET_PARAMS.oracle || !MARKET_PARAMS.irm) {
    throw new Error("All market parameters (COLLATERALTOKEN_ADDRESS, MORPHO_ORACLE_ADDRESS, IRM_ADDRESS) are required.");
  }

  // Calculate market ID
  const marketId = calculateMarketId(MARKET_PARAMS);
  console.log("\n======= Market Information =======");
  console.log("Market ID:", marketId);
  console.log("Market Parameters:");
  console.log("- Loan Token:", MARKET_PARAMS.loanToken);
  console.log("- Collateral Token:", MARKET_PARAMS.collateralToken);
  console.log("- Oracle:", MARKET_PARAMS.oracle);
  console.log("- IRM:", MARKET_PARAMS.irm);
  console.log("- LLTV:", MARKET_PARAMS.lltv.toString());
  console.log("Supply Cap:", SUPPLY_CAP.toString());
  console.log("==================================\n");

  try {
    // Get current timelock value
    const timelockDuration = await publicClient.readContract({
      address: VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "timelock"
    });
    
    console.log(`Vault timelock duration: ${timelockDuration} seconds`);

    // Format market parameters for contract call
    const marketParamsTuple = [
      MARKET_PARAMS.loanToken as `0x${string}`,
      MARKET_PARAMS.collateralToken as `0x${string}`,
      MARKET_PARAMS.oracle as `0x${string}`,
      MARKET_PARAMS.irm as `0x${string}`,
      MARKET_PARAMS.lltv
    ];

    // Submit cap for the market
    console.log(`Submitting cap of ${SUPPLY_CAP.toString()} for market ${marketId}...`);
    const hash = await walletClient.writeContract({
      address: VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "submitCap",
      args: [marketParamsTuple, SUPPLY_CAP]
    });

    console.log("Transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("Cap submitted successfully! Transaction hash:", receipt.transactionHash);

    // Check pending cap information
    const pendingCapInfo = await publicClient.readContract({
      address: VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "pendingCap",
      args: [marketId]
    });

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const validAtTimestamp = Number(pendingCapInfo[1]);
    const timeUntilValid = validAtTimestamp - currentTimestamp;
    
    console.log("\n======= Pending Cap Information =======");
    console.log("Pending Cap Value:", pendingCapInfo[0].toString());
    console.log("Valid At (timestamp):", validAtTimestamp);
    
    if (timeUntilValid > 0) {
      const hours = Math.floor(timeUntilValid / 3600);
      const minutes = Math.floor((timeUntilValid % 3600) / 60);
      const seconds = timeUntilValid % 60;
      console.log(`Time until cap can be accepted: ${hours}h ${minutes}m ${seconds}s`);
      
      const acceptDate = new Date(validAtTimestamp * 1000);
      console.log(`Cap will be ready for acceptance at: ${acceptDate.toLocaleString()}`);
    } else {
      console.log("Cap is READY to be accepted now!");
    }
    console.log("=======================================\n");

    // Provide instructions for accepting the cap
    console.log("To accept the Supply Cap after the timelock period, run addMarketCap script:");

  } catch (error) {
    console.error("Error adding market to vault:", error);
  }
}

// Execute the script
addMarketToVault()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });