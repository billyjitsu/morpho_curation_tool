import { parseAbi } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";
import MetaMorphoABI from "./abis/metamorpho.json";

const walletClient = createWalletByIndex(0);

// Contract addresses
const VAULT_TOKEN_ADDRESS = process.env.VAULT_TOKEN_ADDRESS || "";
const METAMORPHO_FACTORY_ADDRESS = process.env.METAMORPHO_FACTORY_ADDRESS || "";

// Parameters for creating a MetaMorpho vault
const INITIAL_OWNER = walletClient.account.address as `0x${string}`; // Owner of the vault, should be the same as WALLET_ADDRESS
const INITIAL_TIMELOCK = process.env.INITIAL_TIMELOCK
  ? BigInt(process.env.INITIAL_TIMELOCK)
  : 0n; // 0 for no timelock
const VAULT_NAME = process.env.VAULT_NAME || "TEST USDC Vault";
const VAULT_SYMBOL = process.env.VAULT_SYMBOL || "TUSDCv1";
const SALT =
  process.env.SALT ||
  "0x0000000000000000000000000000000000000000000000000000000000000000"; // 0x0 as bytes32

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getVaultAddressFromLogs(
  blockNumber: bigint,
  retries = MAX_RETRIES
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `Attempting to get vault address from logs (attempt ${attempt}/${retries})...`
      );

      const logs = await publicClient.getLogs({
        address: METAMORPHO_FACTORY_ADDRESS,
        event: parseAbi([
          "event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)",
        ])[0],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      });

      if (logs.length > 0 && logs[0].args && logs[0].args.metaMorpho) {
        return logs[0].args.metaMorpho as string;
      }

      if (attempt < retries) {
        console.log(
          `No logs found, waiting ${RETRY_DELAY / 1000} seconds before retry...`
        );
        await sleep(RETRY_DELAY);
      }
    } catch (error) {
      console.log(`Error getting logs on attempt ${attempt}:`, error);
      if (attempt < retries) {
        console.log(`Waiting ${RETRY_DELAY / 1000} seconds before retry...`);
        await sleep(RETRY_DELAY);
      }
    }
  }

  return null;
}

async function main() {
 
  if (!VAULT_TOKEN_ADDRESS) {
    throw new Error("VAULT_TOKEN_ADDRESS environment variable is required");
  }

  console.log("Creating MetaMorpho vault with parameters:");
  console.log(`- Asset: ${VAULT_TOKEN_ADDRESS}`);
  console.log(`- Name: ${VAULT_NAME}`);
  console.log(`- Symbol: ${VAULT_SYMBOL}`);
  console.log(`- Owner: ${INITIAL_OWNER}`);

  try {
    // Create MetaMorpho vault
    const hash = await walletClient.writeContract({
      address: METAMORPHO_FACTORY_ADDRESS,
      abi: MetaMorphoABI,
      functionName: "createMetaMorpho",
      args: [
        INITIAL_OWNER as `0x${string}`,
        INITIAL_TIMELOCK,
        VAULT_TOKEN_ADDRESS as `0x${string}`,
        VAULT_NAME,
        VAULT_SYMBOL,
        SALT as `0x${string}`,
      ],
    });

    console.log("Transaction sent! Waiting for confirmation...");

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log("MetaMorpho vault created successfully!");
    console.log("Transaction hash:", receipt.transactionHash);

    // Try to get the created vault address from the transaction logs with retries
    console.log("Checking transaction logs for the new vault address...");

    const vaultAddress = await getVaultAddressFromLogs(receipt.blockNumber);

    if (vaultAddress) {
      console.log("New MetaMorpho VAULT deployed at:", vaultAddress);
    } else {
      console.log(
        "Vault created but couldn't extract address from logs after multiple attempts. Check the transaction on the block explorer."
      );
    }
  } catch (error) {
    console.error("Error creating MetaMorpho vault:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
