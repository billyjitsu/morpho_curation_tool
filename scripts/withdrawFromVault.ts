import { parseUnits, formatUnits } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import VAULT_ABI from './abis/vault.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);

console.log("Wallet client account:", walletClient.account.address)

let vaultAddress = process.env.VAULT_ADDRESS || "";
let amount = process.env.WITHDRAW_AMOUNT || "1";

// Function to get user input
function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function withdrawFromVault() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it with VAULT_ADDRESS environment variable.");
  }
  if (amount === "0") {
    throw new Error("Withdrawal amount is required. Set it with WITHDRAW_AMOUNT environment variable.");
  }

  try {
    console.log("Getting vault information...");
    
    // Get vault name and symbol
    const vaultName = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "name"
    });
    
    const vaultSymbol = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "symbol"
    });
    
    // Get deposit token address
    const depositTokenAddress = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "asset"
    });
    
    // Get deposit token info (symbol and decimals)
    const [tokenSymbol, tokenDecimals] = await Promise.all([
      publicClient.readContract({
        address: depositTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "symbol"
      }),
      publicClient.readContract({
        address: depositTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals"
      })
    ]);
    
    console.log(`Token: ${tokenSymbol}, Decimals: ${tokenDecimals}`);
    
    // Get current vault total assets
    const totalAssets = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "totalAssets"
    });
    
    // Get the maximum amount the user can withdraw
    const maxWithdraw = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "maxWithdraw",
      args: [walletClient.account.address]
    });
    
    // Get the user's current balance of vault tokens
    const userVaultBalance = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    // Convert the string amount to BigInt with proper decimals
    const withdrawAmount = parseUnits(amount, tokenDecimals as number);
    
    // Check if withdrawal amount exceeds maximum
    if (withdrawAmount > maxWithdraw) {
      console.log(`⚠️ Warning: Requested withdrawal amount (${formatUnits(withdrawAmount, tokenDecimals as number)} ${tokenSymbol}) exceeds your maximum withdrawable amount (${formatUnits(maxWithdraw, tokenDecimals as number)} ${tokenSymbol}).`);
      console.log("The transaction would revert if attempted.");
      
      const useMax = await question("Would you like to withdraw the maximum available amount instead? (y/n): ");
      if (useMax.toLowerCase() === "y") {
        console.log(`Setting withdrawal amount to maximum: ${formatUnits(maxWithdraw, tokenDecimals as number)} ${tokenSymbol}`);
        amount = formatUnits(maxWithdraw, tokenDecimals as number);
      } else {
        console.log("Withdrawal cancelled.");
        return;
      }
    }
    
    // Estimate shares that will be burned for withdrawal
    const sharesToBurn = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "previewWithdraw",
      args: [withdrawAmount]
    });
    
    // Display vault and withdrawal information
    console.log("\n======= Withdrawal Information =======");
    console.log(`Vault: ${vaultName} (${vaultAddress})`);
    console.log(`Vault Symbol: ${vaultSymbol}`);
    console.log(`Underlying Token: ${tokenSymbol} (${depositTokenAddress})`);
    console.log(`Token Decimals: ${tokenDecimals}`);
    console.log(`Current Vault Total Assets: ${formatUnits(totalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Your Vault Token Balance: ${formatUnits(userVaultBalance, tokenDecimals as number)} ${vaultSymbol}`);
    console.log(`Maximum Withdrawable Amount: ${formatUnits(maxWithdraw, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Amount to Withdraw: ${amount} ${tokenSymbol} (${withdrawAmount.toString()} wei)`);
    console.log(`Estimated Shares to Burn: ${formatUnits(sharesToBurn, tokenDecimals as number)} ${vaultSymbol}`);
    console.log("======================================\n");
    
    // Confirm withdrawal action
    const confirm = await question(`Do you want to withdraw ${amount} ${tokenSymbol} from ${vaultName}? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Withdrawal cancelled by user.");
      return;
    }
    
    // Perform withdrawal
    console.log(`Withdrawing ${amount} ${tokenSymbol} from vault...`);
    const withdrawHash = await walletClient.writeContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "withdraw",
      args: [withdrawAmount, walletClient.account.address, walletClient.account.address]
    });
    
    console.log("Withdrawal transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
    
    console.log("✅ Withdrawal successful!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Get new balances
    const newUserVaultBalance = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    const newTotalAssets = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "totalAssets"
    });
    
    const newTokenBalance = await publicClient.readContract({
      address: depositTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    console.log("\n======= Post-Withdrawal Status =======");
    console.log(`New Vault Token Balance: ${formatUnits(newUserVaultBalance, tokenDecimals as number)} ${vaultSymbol}`);
    console.log(`New Vault Total Assets: ${formatUnits(newTotalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`New ${tokenSymbol} Balance: ${formatUnits(newTokenBalance, tokenDecimals as number)} ${tokenSymbol}`);
    console.log("======================================");
    
  } catch (error) {
    console.error("Error withdrawing from vault:", error);
  }
}

withdrawFromVault()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });