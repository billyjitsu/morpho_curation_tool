import { parseUnits, formatUnits, encodeFunctionData } from "viem";
import { publicClient, createWalletByIndex, target_Network } from "../config/configs";
import ERC20_ABI from '../abis/ERC20.json';
import VAULT_ABI from '../abis/vault.json';
import * as readline from 'readline';

// Bundler3 contract interfaces
const BUNDLER3_ABI = [
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "to",
            "type": "address"
          },
          {
            "internalType": "bytes",
            "name": "data",
            "type": "bytes"
          },
          {
            "internalType": "uint256",
            "name": "value",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "skipRevert",
            "type": "bool"
          },
          {
            "internalType": "bytes32",
            "name": "callbackHash",
            "type": "bytes32"
          }
        ],
        "internalType": "struct Call[]",
        "name": "bundle",
        "type": "tuple[]"
      }
    ],
    "name": "multicall",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
] as const;

// GeneralAdapter1 ABI for ERC20 operations  
const GENERAL_ADAPTER_ABI = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "erc20TransferFrom",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "assets",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minShares",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "receiver",
        "type": "address"
      }
    ],
    "name": "erc4626Deposit",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "erc20Transfer",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
] as const;

// Contract addresses - THESE NEED TO BE UPDATED FOR YOUR SPECIFIC NETWORK
// For Base Testnet, you'll need to get the actual deployed addresses
const BUNDLER3_ADDRESS = process.env.BUNDLER3_ADDRESS || "0x0000000000000000000000000000000000000000"; 
const GENERAL_ADAPTER_ADDRESS = process.env.GENERAL_ADAPTER_ADDRESS || "0x0000000000000000000000000000000000000000"; 

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

async function depositToVaultWithBundler3() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it with VAULT_ADDRESS environment variable.");
  }
  if (amount === "0") {
    throw new Error("Deposit amount is required. Set it with DEPOSIT_AMOUNT environment variable.");
  }
  if (BUNDLER3_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("Bundler3 address is required. Set it with BUNDLER3_ADDRESS environment variable.");
  }
  if (GENERAL_ADAPTER_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("GeneralAdapter address is required. Set it with GENERAL_ADAPTER_ADDRESS environment variable.");
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
    console.log("\n======= Bundler3 Deposit Information =======");
    console.log(`Vault: ${vaultName} (${vaultAddress})`);
    console.log(`Deposit Token: ${tokenSymbol} (${depositTokenAddress})`);
    console.log(`Token Decimals: ${tokenDecimals}`);
    console.log(`Current Vault Total Assets: ${formatUnits(totalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Your ${tokenSymbol} Balance: ${formatUnits(userBalance, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Amount to Deposit: ${amount} ${tokenSymbol} (${depositAmount.toString()} wei)`);
    console.log(`Estimated Shares to Receive: ${formatUnits(estimatedShares, tokenDecimals as number)}`);
    console.log(`Bundler3 Address: ${BUNDLER3_ADDRESS}`);
    console.log(`GeneralAdapter Address: ${GENERAL_ADAPTER_ADDRESS}`);
    console.log("============================================\n");
    
    // Check if user has enough balance
    if (userBalance < depositAmount) {
      throw new Error(`Insufficient balance. You have ${formatUnits(userBalance, tokenDecimals as number)} ${tokenSymbol}, but trying to deposit ${amount} ${tokenSymbol}.`);
    }
    
    // Check current allowance to GeneralAdapter (NOT Bundler3!)
    const currentAllowance = await publicClient.readContract({
      address: depositTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [walletClient.account.address, GENERAL_ADAPTER_ADDRESS]
    });
    
    // Approve GeneralAdapter to spend tokens if needed
    if (currentAllowance < depositAmount) {
      console.log(`Approving ${GENERAL_ADAPTER_ADDRESS} (GeneralAdapter) to spend ${amount} ${tokenSymbol}...`);
      
      const approveHash = await walletClient.writeContract({
        address: depositTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GENERAL_ADAPTER_ADDRESS as `0x${string}`, depositAmount]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    } else {
      console.log("Token allowance to GeneralAdapter is already sufficient.");
    }
    
    // Confirm bundled deposit action
    const confirm = await question(`Do you want to deposit ${amount} ${tokenSymbol} to ${vaultName} using Bundler3? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Deposit cancelled by user.");
      return;
    }
    
    // Create bundled calls
    console.log("Creating bundled transaction...");
    
    // Call 1: Transfer tokens from user to GeneralAdapter
    const transferFromData = encodeFunctionData({
      abi: GENERAL_ADAPTER_ABI,
      functionName: "erc20TransferFrom",
      args: [depositTokenAddress, depositAmount]
    });
    
    // Call 2: Deposit to vault via GeneralAdapter
    const depositData = encodeFunctionData({
      abi: GENERAL_ADAPTER_ABI,
      functionName: "erc4626Deposit",
      args: [vaultAddress, depositAmount, 0n, walletClient.account.address] // minShares = 0 for simplicity
    });
    
    // Create the bundle
    const bundle = [
      {
        to: GENERAL_ADAPTER_ADDRESS as `0x${string}`,
        data: transferFromData,
        value: 0n,
        skipRevert: false,
        callbackHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`
      },
      {
        to: GENERAL_ADAPTER_ADDRESS as `0x${string}`,
        data: depositData,
        value: 0n,
        skipRevert: false,
        callbackHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`
      }
    ];
    
    // Execute the bundled transaction
    console.log(`Executing bundled deposit via Bundler3...`);
    const bundledHash = await walletClient.writeContract({
      address: BUNDLER3_ADDRESS as `0x${string}`,
      abi: BUNDLER3_ABI,
      functionName: "multicall",
      args: [bundle]
    });
    
    console.log("Bundled transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: bundledHash });
    
    console.log("✅ Bundled deposit successful!");
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
    
    const userVaultShares = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    });
    
    console.log("\n======= Post-Bundled Deposit Status =======");
    console.log(`New ${tokenSymbol} Balance: ${formatUnits(newUserBalance, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`New Vault Total Assets: ${formatUnits(newTotalAssets, tokenDecimals as number)} ${tokenSymbol}`);
    console.log(`Your Vault Shares: ${formatUnits(userVaultShares, tokenDecimals as number)}`);
    console.log("===========================================");
    
  } catch (error) {
    console.error("Error executing bundled deposit:", error);
  }
}

// Alternative function for Permit2 integration (more advanced)
async function depositToVaultWithPermit2() {
  // This would use Permit2 signatures instead of pre-approval
  // Implementation would require Permit2 integration
  console.log("Permit2 integration not implemented in this example");
}

depositToVaultWithBundler3()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });