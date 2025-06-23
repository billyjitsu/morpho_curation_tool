import { publicClient, createWalletByIndex } from "./config/configs";
import VAULT_ABI from './abis/vault.json';
import * as readline from 'readline';

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

async function updateWithdrawQueue() {
  // Validate required parameters
  if (!vaultAddress) {
    throw new Error("Vault address is required. Set it in VAULT_ADDRESS environment variable.");
  }
  if (marketIds.length === 0) {
    throw new Error("At least one market ID is required.");
  }

  try {
    console.log("Checking current withdraw queue...");
    
    // Get the current withdraw queue length
    const queueLength = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "withdrawQueueLength"
    });
    
    const currentQueue: string[] = [];
    
    // Read each market ID in the current withdraw queue
    if (Number(queueLength) > 0) {
      for (let i = 0; i < Number(queueLength); i++) {
        const marketId = await publicClient.readContract({
          address: vaultAddress as `0x${string}`,
          abi: VAULT_ABI,
          functionName: "withdrawQueue",
          args: [BigInt(i)]
        });
        currentQueue.push(marketId as string);
      }
    }
    
    console.log("Current withdraw queue:", currentQueue);
    
    // For withdraw queue, we need to determine indexes to update
    // First, check if any market IDs are already in the queue
    const marketIdIndexes: number[] = [];
    let allExist = true;
    
    for (const marketId of marketIds) {
      const index = currentQueue.indexOf(marketId);
      if (index === -1) {
        console.log(`Market ID ${marketId} is not in the current withdraw queue.`);
        allExist = false;
        break;
      }
      marketIdIndexes.push(index);
    }
    
    if (!allExist) {
      console.log("Cannot proceed: Some market IDs are not in the current withdraw queue.");
      console.log("For withdraw queue, market IDs must first be in the queue before their positions can be updated.");
      console.log("Please add missing market IDs to the withdraw queue first.");
      return;
    }
    
    console.log("\nCurrent indexes of specified market IDs:", marketIdIndexes);
    
    // Ask for new positions
    console.log("\nEnter new index positions for each market ID (0 is the first position):");
    const newIndexes: number[] = [];
    
    for (let i = 0; i < marketIds.length; i++) {
      const currentIndex = marketIdIndexes[i];
      const newIndex = await question(`New index for market ${marketIds[i]} (currently at index ${currentIndex}): `);
      const parsedIndex = parseInt(newIndex);
      
      if (isNaN(parsedIndex) || parsedIndex < 0 || parsedIndex >= currentQueue.length) {
        throw new Error(`Invalid index. Must be between 0 and ${currentQueue.length - 1}.`);
      }
      
      newIndexes.push(parsedIndex);
    }
    
    console.log("\nSummary of changes:");
    for (let i = 0; i < marketIds.length; i++) {
      console.log(`Market ${marketIds[i]}: index ${marketIdIndexes[i]} -> ${newIndexes[i]}`);
    }
    
    // For updateWithdrawQueue, we need to specify an array of the same length as the queue
    // where each entry indicates the new index for that position
    const updateIndexes: number[] = [];
    
    // Start with the default ordering (no change)
    for (let i = 0; i < currentQueue.length; i++) {
      updateIndexes.push(i);
    }
    
    // Apply our specific changes
    for (let i = 0; i < marketIds.length; i++) {
      const currentIndex = marketIdIndexes[i];
      const newIndex = newIndexes[i];
      
      // Skip if no change
      if (currentIndex === newIndex) continue;
      
      // Swap the index values
      updateIndexes[currentIndex] = newIndex;
      
      // Find and update the index that currently points to newIndex
      const conflictingIndex = updateIndexes.findIndex((value, idx) => value === newIndex && idx !== currentIndex);
      if (conflictingIndex !== -1) {
        updateIndexes[conflictingIndex] = currentIndex;
      }
    }
    
    console.log("\nUpdate indexes array:", updateIndexes);
    
    // Confirm before setting
    const confirm = await question('Do you want to proceed with updating the withdraw queue? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Operation cancelled by user.");
      return;
    }
    
    // Update the withdraw queue
    console.log("Updating withdraw queue...");
    const hash = await walletClient.writeContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "updateWithdrawQueue",
      args: [updateIndexes.map(idx => BigInt(idx))]
    });
    
    console.log("Transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    console.log("✅ Withdraw queue updated successfully!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Verify the new queue
    console.log("\nVerifying updated withdraw queue...");
    const newQueueLength = await publicClient.readContract({
      address: vaultAddress as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "withdrawQueueLength"
    });
    
    const verifiedQueue: string[] = [];
    
    for (let i = 0; i < Number(newQueueLength); i++) {
      const marketId = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "withdrawQueue",
        args: [BigInt(i)]
      });
      verifiedQueue.push(marketId as string);
    }
    
    console.log("Updated withdraw queue:", verifiedQueue);
    
    // Check if the market IDs are at their specified indexes in the verified queue
    let allCorrect = true;
    for (let i = 0; i < marketIds.length; i++) {
      const expectedIndex = newIndexes[i];
      const actualMarketId = verifiedQueue[expectedIndex];
      
      if (actualMarketId !== marketIds[i]) {
        console.log(`⚠️ Warning: Market ${marketIds[i]} should be at index ${expectedIndex}, but found ${actualMarketId}`);
        allCorrect = false;
      }
    }
    
    if (allCorrect) {
      console.log("✅ All market IDs are at their expected positions!");
    }
    
    console.log("\nVault configuration complete. You can now allocate funds using the reallocate method.");
    
  } catch (error) {
    console.error("Error updating withdraw queue:", error);
  }
}

updateWithdrawQueue()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });