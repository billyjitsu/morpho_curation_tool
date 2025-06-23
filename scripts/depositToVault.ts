import { parseUnits, formatUnits } from "viem";
import { publicClient, createWalletByIndex, target_Network } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import VAULT_ABI from './abis/vault.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);
console.log("Wallet Client address:", walletClient.account.address);

let vaultAddress = process.env.VAULT_ADDRESS || "";
let amount = process.env.DEPOSIT_AMOUNT || "10000";

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

async function depositToVault() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it with VAULT_ADDRESS environment variable.");
  }
  if (amount === "0") {
    throw new Error("Deposit amount is required. Set it with DEPOSIT_AMOUNT environment variable.");
  }

  try {
    console.log("Getting vault information...");
    
    // Get vault name
    const vaultName = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "name"
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
    
    // Convert the string amount to BigInt with proper decimals
    const depositAmount = parseUnits(amount, tokenDecimals as number);
    
    // Get the user's current balance
    const userBalance = await publicClient.readContract({
      address: depositTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    // Estimate shares that will be received
    const estimatedShares = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "convertToShares",
      args: [depositAmount]
    });
    
    // Display vault and deposit information
    console.log("\n======= Deposit Information =======");
    console.log(`Vault: ${vaultName} (${vaultAddress})`);
    console.log(`Deposit Token: ${tokenSymbol} (${depositTokenAddress})`);
    console.log(`Token Decimals: ${tokenDecimals}`);
    console.log(`Current Vault Total Assets: ${formatUnits(totalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Your ${tokenSymbol} Balance: ${formatUnits(userBalance, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Amount to Deposit: ${amount} ${tokenSymbol} (${depositAmount.toString()} wei)`);
    console.log(`Estimated Shares to Receive: ${formatUnits(estimatedShares, tokenDecimals as number)}`);
    console.log("==================================\n");
    
    // Check if user has enough balance
    if (userBalance < depositAmount) {
      throw new Error(`Insufficient balance. You have ${formatUnits(userBalance, tokenDecimals as number)} ${tokenSymbol}, but trying to deposit ${amount} ${tokenSymbol}.`);
    }
    
    // Check current allowance
    const currentAllowance = await publicClient.readContract({
      address: depositTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletClient.account.address, vaultAddress]
    });
    
    // Approve vault to spend tokens if needed
    if (currentAllowance < depositAmount) {
      console.log(`Approving ${vaultAddress} to spend ${amount} ${tokenSymbol}...`);
      
      const approveHash = await walletClient.writeContract({
        address: depositTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vaultAddress as `0x${string}`, depositAmount]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    } else {
      console.log("Token allowance is already sufficient.");
    }
    
    // Confirm deposit action
    const confirm = await question(`Do you want to deposit ${amount} ${tokenSymbol} to ${vaultName}? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Deposit cancelled by user.");
      return;
    }
    
    // Perform deposit
    console.log(`Depositing ${amount} ${tokenSymbol} to vault...`);
    const depositHash = await walletClient.writeContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [depositAmount, walletClient.account.address]
    });
    
    console.log("Deposit transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
    
    console.log("✅ Deposit successful!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Get new balances
    const newUserBalance = await publicClient.readContract({
      address: depositTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    const newTotalAssets = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "totalAssets"
    });
    
    console.log("\n======= Post-Deposit Status =======");
    console.log(`New ${tokenSymbol} Balance: ${formatUnits(newUserBalance, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`New Vault Total Assets: ${formatUnits(newTotalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log("===================================");
    
  } catch (error) {
    console.error("Error depositing to vault:", error);
  }
}

depositToVault()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });