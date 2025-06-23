import { parseUnits, formatUnits, type Address } from "viem";
import { publicClient, createWalletByIndex, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);

// Environment variables
let flashLoanContractAddress = process.env.FLASHLOAN_CONTRACT_ADDRESS || "";
let morphoAddress = process.env.MORPHO_ADDRESS || "";
let tokenAddress = process.env.TOKEN_ADDRESS || "";
let flashLoanAmount = process.env.FLASHLOAN_AMOUNT || "0.1";

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

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

// Fetch token information with proper error handling
async function fetchTokenInfo(tokenAddress: Address): Promise<TokenInfo> {
  try {
    const [symbol, decimals, name] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "name",
      }).catch(() => "Unknown Token")
    ]);

    return {
      address: tokenAddress,
      symbol: symbol as string,
      decimals: decimals as number,
      name: name as string,
    };
  } catch (error) {
    console.error(`Error fetching token info for ${tokenAddress}:`, error);
    throw new Error("Could not read token info. Is the token address correct?");
  }
}

async function main() {
  console.log("Simple Flash Loan Demo");
  console.log("=========================");
  console.log("This demo will borrow tokens via flash loan and immediately repay them");

  console.log("Executor address:", walletClient.account.address);
  
  // Validate required parameters
  if (!flashLoanContractAddress) {
    console.error("❌ Flash loan contract address not found. Please set FLASHLOAN_CONTRACT_ADDRESS");
    process.exit(1);
  }

  if (!morphoAddress) {
    console.error("❌ Morpho address not found. Please set MORPHO_ADDRESS");
    process.exit(1);
  }

  console.log("Flash Loan Contract:", flashLoanContractAddress);
  console.log("Morpho Protocol:", morphoAddress);

  // Interactive mode if no token address provided
  if (!tokenAddress) {
    console.log("\n🔧 Configuration");
    console.log("=================");
    
    tokenAddress = await question("Enter token address to flash loan: ");
    flashLoanAmount = await question(`Enter flash loan amount (default: ${flashLoanAmount}): `) || flashLoanAmount;
  }

  if (!tokenAddress) {
    console.error("❌ Token address is required");
    process.exit(1);
  }

  // Get token information using the structured approach
  const tokenInfo = await fetchTokenInfo(tokenAddress as Address);
  
  // Convert amount to BigInt with proper decimals
  const flashLoanAmountBigInt = parseUnits(flashLoanAmount, tokenInfo.decimals);

  // Check Morpho's token balance (flash loan liquidity)
  const morphoBalance = await publicClient.readContract({
    address: tokenInfo.address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [morphoAddress as Address]
  }) as bigint;

  // Get our current balance
  const ourBalance = await publicClient.readContract({
    address: tokenInfo.address,
    abi: ERC20_ABI,
    functionName: "balanceOf", 
    args: [walletClient.account.address]
  }) as bigint;

  console.log("\n📊 Flash Loan Details");
  console.log("=====================");
  console.log(`Token: ${tokenInfo.name} (${tokenInfo.symbol})`);
  console.log(`Address: ${tokenInfo.address}`);
  console.log(`Decimals: ${tokenInfo.decimals}`);
  console.log(`Borrow Amount: ${flashLoanAmount} ${tokenInfo.symbol}`);
  console.log(`Fee: 0 ${tokenInfo.symbol} (Morpho flash loans are FREE!)`);
  console.log(`Repay Amount: ${flashLoanAmount} ${tokenInfo.symbol} (same as borrowed)`);
  console.log(`Available Liquidity: ${formatUnits(morphoBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`);
  console.log(`Your Current Balance: ${formatUnits(ourBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`);

  // Validate liquidity
  if (morphoBalance < flashLoanAmountBigInt) {
    console.log(`❌ Insufficient liquidity in Morpho for flash loan`);
    console.log(`Requested: ${flashLoanAmount} ${tokenInfo.symbol}`);
    console.log(`Available: ${formatUnits(morphoBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`);
    return;
  }

  console.log("\n⚡ Flash Loan Flow:");
  console.log("1. Request flash loan from Morpho");
  console.log("2. Receive tokens in contract");
  console.log("3. Contract logs receipt of tokens");
  console.log("4. Flash loan automatically repaid");
  console.log("5. Check final balances");

  // Get flash loan contract instance
  const flashLoanContract = {
    address: flashLoanContractAddress as Address,
    abi: [
      {
        "inputs": [
          { "name": "token", "type": "address" },
          { "name": "amount", "type": "uint256" }
        ],
        "name": "executeFlashLoan",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
      },
      {
        "inputs": [],
        "name": "owner",
        "outputs": [{ "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
      }
    ]
  };

  // Check contract ownership
  try {
    const contractOwner = await publicClient.readContract({
      address: flashLoanContract.address,
      abi: flashLoanContract.abi,
      functionName: "owner"
    }) as Address;
    
    if (contractOwner.toLowerCase() !== walletClient.account.address.toLowerCase()) {
      console.log("⚠️ Warning: You are not the contract owner.");
    } else {
      console.log("✅ You are the contract owner.");
    }
  } catch (error) {
    console.log("⚠️ Could not check contract ownership");
  }

  // Confirm execution
  const confirm = await question("\n⚠️ Execute flash loan demo? (y/n): ");
  if (confirm.toLowerCase() !== 'y') {
    console.log("Flash loan cancelled by user.");
    return;
  }

  try {
    console.log("\n⚡ Executing flash loan...");
    
    // Execute the flash loan
    const txHash = await walletClient.writeContract({
      address: flashLoanContract.address,
      abi: flashLoanContract.abi,
      functionName: "executeFlashLoan",
      args: [tokenInfo.address, flashLoanAmountBigInt]
    });

    console.log("Flash loan transaction sent:", txHash);
    console.log("Waiting for confirmation...");

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "success") {
      console.log("✅ Flash loan executed successfully!");
      console.log("Transaction hash:", receipt.transactionHash);
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);

      // Check final balances
      const finalOurBalance = await publicClient.readContract({
        address: tokenInfo.address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletClient.account.address]
      }) as bigint;
      
      const finalContractBalance = await publicClient.readContract({
        address: tokenInfo.address,
        abi: ERC20_ABI,
        functionName: "balanceOf", 
        args: [flashLoanContract.address]
      }) as bigint;

      console.log("\n💰 Final Balances:");
      console.log(`Your Balance: ${formatUnits(finalOurBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`Contract Balance: ${formatUnits(finalContractBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`);

      // Parse events for more details
      console.log("\n📋 Events Emitted:");
      const logs = await publicClient.getLogs({
        address: flashLoanContract.address,
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber
      });

      if (logs.length > 0) {
        console.log(`Found ${logs.length} event(s) from our contract`);
        logs.forEach((log, index) => {
          console.log(`Event ${index + 1}: Topic ${log.topics[0]}`);
        });
      }

      console.log("\n🎉 Flash loan demo completed successfully!");
      console.log("The contract successfully:");
      console.log("- Borrowed tokens from Morpho");
      console.log("- Received the tokens in the callback");
      console.log("- Automatically repaid the exact borrowed amount");
      console.log("- No fees were charged (Morpho flash loans are free!)");

    } else {
      console.log("❌ Flash loan transaction failed!");
      console.log("Transaction hash:", receipt.transactionHash);
    }

  } catch (error: any) {
    console.error("❌ Flash loan execution failed:", error);
    
    // Common error explanations
    if (error.message?.includes("InsufficientBalance")) {
      console.log("\n💡 Insufficient balance to repay the flash loan.");
      console.log("This shouldn't happen in the simple demo unless there's an issue with the contract logic.");
    } else if (error.message?.includes("UnauthorizedFlashLoan")) {
      console.log("\n💡 Unauthorized flash loan call.");
      console.log("The callback wasn't called by the expected Morpho contract.");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Execution failed:", error);
    process.exit(1);
  });