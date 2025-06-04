import { parseAbi } from "viem";
import { publicClient, walletClient, account } from "./config/configs";
import MetaMorphoABI from './abis/metamorpho.json';

// Contract addresses
const VAULT_TOKEN_ADDRESS = process.env.VAULT_TOKEN_ADDRESS || "";
const METAMORPHO_FACTORY_ADDRESS = process.env.METAMORPHO_FACTORY_ADDRESS || "";

// Parameters for creating a MetaMorpho vault
const INITIAL_OWNER = account.address as `0x${string}`; // Owner of the vault, should be the same as WALLET_ADDRESS
const INITIAL_TIMELOCK = process.env.INITIAL_TIMELOCK ? BigInt(process.env.INITIAL_TIMELOCK) : 0n; // 0 for no timelock
const VAULT_NAME = process.env.VAULT_NAME || "TEST USDC Vault";
const VAULT_SYMBOL = process.env.VAULT_SYMBOL || "TUSDCv1";
const SALT = process.env.SALT || "0x0000000000000000000000000000000000000000000000000000000000000000"; // 0x0 as bytes32

async function main() {
  if (!account) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }
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

    // Try to get the created vault address from the transaction logs
    console.log("Checking transaction logs for the new vault address...");
    
    // The first event should be CreateMetaMorpho which contains the metaMorpho address
    try {
      const logs = await publicClient.getLogs({
        address: METAMORPHO_FACTORY_ADDRESS,
        event: parseAbi([
          "event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)",
        ])[0],
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      if (logs.length > 0 && logs[0].args) {
        console.log("New MetaMorpho VAULT deployed at:", logs[0].args.metaMorpho);
      } else {
        console.log("Vault created but couldn't extract address from logs. Check the transaction on the block explorer.");
      }
    } catch (error) {
      console.log("Couldn't parse logs, check the transaction on the block explorer.");
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