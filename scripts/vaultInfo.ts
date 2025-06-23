import { parseAbi, formatUnits } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";

const walletClient = createWalletByIndex(0);

// Contract addresses
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";

// ABIs (partial for what we need)
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
]);

// Using more complete ABI for the vault to catch more errors
const VAULT_ABI = parseAbi([
  // Vault info functions
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  
  // Config and queue functions
  "function supplyQueueLength() view returns (uint256)",
  "function withdrawQueueLength() view returns (uint256)",
  "function supplyQueue(uint256) view returns (bytes32)",
  "function withdrawQueue(uint256) view returns (bytes32)",
  "function config(bytes32) view returns (uint184 cap, bool enabled, uint64 removableAt)",
  
  // Main operations
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)"
]);


async function main() {
  // Get vault information
  try {
    // Get vault info
    const [vaultName, vaultSymbol, assetAddress] = await Promise.all([
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "name",
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI, 
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "asset",
      }),
    ]);

    // Get asset info
    const [assetName, assetSymbol, assetDecimals] = await Promise.all([
      publicClient.readContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "name",
      }),
      publicClient.readContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);

    console.log("\n=== Vault Information ===");
    console.log(`Vault Name: ${vaultName}`);
    console.log(`Vault Symbol: ${vaultSymbol}`);
    console.log(`Underlying Asset: ${assetName} (${assetSymbol})`);
    console.log(`Asset Address: ${assetAddress}`);
    console.log(`Asset Decimals: ${assetDecimals}`);

    // Get user balance info
    const [userAssetBalance, userVaultShares] = await Promise.all([
      publicClient.readContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletClient.account.address],
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "balanceOf",
        args: [walletClient.account.address],
      }),
    ]);

    // Get vault asset value of user shares
    const userAssetsInVault = await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "convertToAssets",
      args: [userVaultShares],
    });

    console.log("\n=== User Portfolio ===");
    console.log(`${assetSymbol} Balance: ${formatUnits(userAssetBalance, assetDecimals)}`);
    console.log(`Vault Shares: ${formatUnits(userVaultShares, assetDecimals)}`);
    console.log(`Assets in Vault: ${formatUnits(userAssetsInVault, assetDecimals)} ${assetSymbol}`);

    // Get vault stats
    const [totalAssets, maxDeposit, maxWithdraw] = await Promise.all([
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "maxDeposit",
        args: [walletClient.account.address],
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "maxWithdraw",
        args: [walletClient.account.address],
      }),
    ]);

    console.log("\n=== Vault Stats ===");
    console.log(`Total Assets: ${formatUnits(totalAssets, assetDecimals)} ${assetSymbol}`);
    console.log(`Maximum Deposit: ${maxDeposit === BigInt(2) ** BigInt(256) - BigInt(1) ? "Unlimited" : formatUnits(maxDeposit, assetDecimals)} ${assetSymbol}`);
    console.log(`Maximum Withdrawal: ${formatUnits(maxWithdraw, assetDecimals)} ${assetSymbol}`);
      
    await getMarketInfo(publicClient, assetDecimals, assetSymbol);
 
  } catch (error) {
    console.error("Error:", error);
  }
}

/**
 * Get information about the markets in the vault's supply and withdraw queues
 */
async function getMarketInfo(publicClient, assetDecimals, assetSymbol) {
  console.log("\n=== Vault Markets Information ===");
  
  try {
    // Get supply queue length
    const supplyQueueLength = await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "supplyQueueLength"
    });
    
    console.log(`Supply Queue Length: ${supplyQueueLength}`);
    
    // Get supply queue markets
    if (supplyQueueLength > 0) {
      console.log("\nSupply Queue Markets:");
      for (let i = 0; i < Number(supplyQueueLength); i++) {
        const marketId = await publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "supplyQueue",
          args: [BigInt(i)]
        });
        
        // Get market config
        const marketConfig = await publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "config",
          args: [marketId]
        });
        
        const cap = marketConfig[0];
        const enabled = marketConfig[1];
        const removableAt = marketConfig[2];
        
        console.log(`Market ${i}: ${marketId}`);
        console.log(`  Cap: ${formatUnits(cap, assetDecimals)} ${assetSymbol}`);
        console.log(`  Enabled: ${enabled}`);
        console.log(`  Removable At: ${new Date(Number(removableAt) * 1000).toLocaleString()}`);
      }
    } else {
      console.log("\n⚠️ No markets in supply queue - deposits are disabled!");
    }
    
    // Get withdraw queue length
    const withdrawQueueLength = await publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "withdrawQueueLength"
    });
    
    console.log(`\nWithdraw Queue Length: ${withdrawQueueLength}`);
    
    // Get withdraw queue markets
    if (withdrawQueueLength > 0) {
      console.log("\nWithdraw Queue Markets:");
      for (let i = 0; i < Number(withdrawQueueLength); i++) {
        const marketId = await publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "withdrawQueue",
          args: [BigInt(i)]
        });
        
        console.log(`Market ${i}: ${marketId}`);
      }
    } else {
      console.log("\n⚠️ No markets in withdraw queue - withdrawals are disabled!");
    }
    
    console.log("\nHint: If there are no markets or they have zero caps, you need to wait for the vault curator to enable markets and set caps.");
    
  } catch (error) {
    console.error("Error getting market information:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });