import { publicClient, createWalletByIndex } from "./config/configs";
import * as readline from 'readline';
import VAULT_ABI from './abis/vault.json';

const walletClient = createWalletByIndex(0);

let vaultAddress = process.env.VAULT_ADDRESS || "";
let marketIds: string[] = [process.env.MARKET_ID || ""];

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

async function setSupplyQueue() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it with VAULT_ADDRESS environment variable.");
  }
  if (marketIds.length === 0) {
    throw new Error("At least one market ID is required.");
  }

  try {
    console.log("Checking current supply queue...");
    
    // Get the current supply queue length
    const queueLength = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "supplyQueueLength"
    });
    
    const currentQueue: string[] = [];
    
    // Read each market ID in the current supply queue
    if (Number(queueLength) > 0) {
      for (let i = 0; i < Number(queueLength); i++) {
        const marketId = await publicClient.readContract({
          address: vaultAddress as `0x${string}`,
          abi: VAULT_ABI,
          functionName: "supplyQueue",
          args: [BigInt(i)]
        });
        currentQueue.push(marketId as string);
      }
    }
    
    console.log("Current supply queue:", currentQueue);
    
    // Determine the new queue
    let newQueue: string[];
    
    if (currentQueue.length === 0) {
      // If the current queue is empty, use the provided market IDs
      newQueue = marketIds;
    } else {
      // Ask whether to append to or replace the current queue
      console.log("\nOptions:");
      console.log("1. Replace current queue with new market IDs");
      console.log("2. Append new market IDs to current queue");
      
      const option = await question('Select option (1 or 2): ');
      
      if (option === "1") {
        newQueue = marketIds;
      } else if (option === "2") {
        // Check for duplicates
        newQueue = [...currentQueue];
        for (const marketId of marketIds) {
          if (!newQueue.includes(marketId)) {
            newQueue.push(marketId);
          }
        }
      } else {
        throw new Error("Invalid option. Please select 1 or 2.");
      }
    }
    
    console.log("\nNew supply queue will be:", newQueue);
    
    // Confirm before setting
    const confirm = await question('Do you want to proceed with setting this supply queue? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Operation cancelled by user.");
      return;
    }
    
    // Set the supply queue
    console.log("Setting supply queue...");
    const hash = await walletClient.writeContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "setSupplyQueue",
      args: [newQueue.map(id => id as `0x${string}`)]
    });
    
    console.log("Transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    console.log("✅ Supply queue set successfully!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Verify the new queue
    console.log("\nVerifying new supply queue...");
    const newQueueLength = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "supplyQueueLength"
    });
    
    const verifiedQueue: string[] = [];
    
    for (let i = 0; i < Number(newQueueLength); i++) {
      const marketId = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "supplyQueue",
        args: [BigInt(i)]
      });
      verifiedQueue.push(marketId as string);
    }
    
    console.log("Updated supply queue:", verifiedQueue);
    
    // Check if the verified queue matches the expected new queue
    const allMatch = newQueue.length === verifiedQueue.length && 
                      newQueue.every((id, index) => id === verifiedQueue[index]);
    
    if (allMatch) {
      console.log("✅ Supply queue verified successfully!");
    } else {
      console.log("⚠️ Warning: The verified queue does not match the expected queue.");
    }
    
    console.log("\nNext step: Set up the withdraw queue if needed.");
    // console.log(`Run: npx tsx scripts/updateWithdrawQueue.ts --vault=${vaultAddress} --marketIds=${marketIds.join(',')}`);
    
  } catch (error) {
    console.error("Error setting supply queue:", error);
  }
}

setSupplyQueue()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });