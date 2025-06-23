import { publicClient, createWalletByIndex } from "./config/configs";
import VAULT_ABI from './abis/vault.json';

const walletClient = createWalletByIndex(0);

// Your vault address (this will be filled in after creation)
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";

// Role addresses
const CURATOR_ADDRESS =  process.env.CURATOR_ADDRESS || "";
const ALLOCATOR_ADDRESS = process.env.ALLOCATOR_ADDRESS || "";
const GUARDIAN_ADDRESS = process.env.GUARDIAN_ADDRESS || "";
const FEE_RECIPIENT_ADDRESS = process.env.FEE_RECIPIENT_ADDRESS || "";
const SKIM_RECIPIENT_ADDRESS = process.env.SKIM_RECIPIENT_ADDRESS || "";
// Fee configuration (1% - 18 decimals)
const FEE_AMOUNT = process.env.FEE_AMOUNT ? BigInt(process.env.FEE_AMOUNT) : 10000000000000000n;

// Function to wait for user confirmation
async function waitForConfirmation(message: string): Promise<void> {
  console.log(message);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdin.resume();
    stdout.write('Press ENTER to continue...');

    stdin.once('data', () => {
      stdin.pause();
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupVault() {
  if (!VAULT_ADDRESS) {
    throw new Error("VAULT_ADDRESS environment variable is required. Set it to your newly created vault address.");
  }

  console.log("Starting vault setup for:", VAULT_ADDRESS);

  // Setup tasks array - we'll execute these in order
  const setupTasks = [];

  // 1. Set Curator (if provided)
  if (CURATOR_ADDRESS) {
    setupTasks.push(async () => {
      console.log(`Setting curator to ${CURATOR_ADDRESS}...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setCurator",
        args: [CURATOR_ADDRESS as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Curator set successfully! Transaction hash:", receipt.transactionHash);
    });
  }

  // 2. Set Allocator (if provided)
  if (ALLOCATOR_ADDRESS) {
    setupTasks.push(async () => {
      console.log(`Setting allocator ${ALLOCATOR_ADDRESS} to true...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setIsAllocator",
        args: [ALLOCATOR_ADDRESS as `0x${string}`, true],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Allocator set successfully! Transaction hash:", receipt.transactionHash);
    });
  }

  // 3. Submit Guardian (if provided)
  if (GUARDIAN_ADDRESS) {
    setupTasks.push(async () => {
      console.log(`Submitting guardian ${GUARDIAN_ADDRESS}...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "submitGuardian",
        args: [GUARDIAN_ADDRESS as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Guardian submitted successfully! Transaction hash:", receipt.transactionHash);
      
      console.log("NOTE: The guardian must now accept this role from their address.");
      console.log(`The guardian should call acceptGuardian() on the vault address ${VAULT_ADDRESS}`);
    });
  }

  // 4. Set Fee Recipient (if provided)
  if (FEE_RECIPIENT_ADDRESS) {
    setupTasks.push(async () => {
      console.log(`Setting fee recipient to ${FEE_RECIPIENT_ADDRESS}...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setFeeRecipient",
        args: [FEE_RECIPIENT_ADDRESS as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Fee recipient set successfully! Transaction hash:", receipt.transactionHash);
    });

    // 5. Set Fee (only if fee recipient is set)
    setupTasks.push(async () => {
      console.log(`Setting fee to 1% (${FEE_AMOUNT})...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setFee",
        args: [FEE_AMOUNT],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Fee set successfully! Transaction hash:", receipt.transactionHash);
    });
  }

  // 6. Set Skim Recipient (if provided)
  if (SKIM_RECIPIENT_ADDRESS) {
    setupTasks.push(async () => {
      console.log(`Setting skim recipient to ${SKIM_RECIPIENT_ADDRESS}...`);
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setSkimRecipient",
        args: [SKIM_RECIPIENT_ADDRESS as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ Skim recipient set successfully! Transaction hash:", receipt.transactionHash);
    });
  }

  // Execute setup tasks with confirmation between each step
  for (let i = 0; i < setupTasks.length; i++) {
    try {
      await setupTasks[i]();
      
      // If there are more tasks, ask for confirmation before continuing
      if (i < setupTasks.length - 1) {
        await waitForConfirmation("\nReady for next step?");
      }
    } catch (error) {
      console.error(`Error in step ${i + 1}:`, error);
      break;
    }
  }

  console.log("\n=== 🎉 Basic Vault Setup Complete 🎉 ===");
}

setupVault()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });