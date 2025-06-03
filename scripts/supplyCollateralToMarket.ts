import { parseUnits, formatUnits } from "viem";
import { publicClient, walletClient, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';
import * as readline from 'readline';

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let collateralAmount = process.env.COLLATERAL_AMOUNT || "10000";

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

async function supplyCollateral() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with --morpho=0x... or in MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with --marketId=0x... or in MARKET_ID environment variable.");
  }
  if (collateralAmount === "0") {
    throw new Error("Collateral amount is required. Set it with --amount=<amount> or in COLLATERAL_AMOUNT environment variable.");
  }


  try {
    console.log("Getting market information...");
    
    // Get market parameters
    let marketParams;
    try {
      marketParams = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "idToMarketParams",
        args: [marketId as `0x${string}`]
      });
      console.log("✅ Market exists!");
    } catch (error) {
      console.error("❌ Market does not exist or couldn't be fetched. Make sure the market ID is correct.");
      throw error;
    }
    
    // When calling supplyCollateral, format the market params as a tuple
    const marketParamsTuple = {
      loanToken: marketParams[0],
      collateralToken: marketParams[1],
      oracle: marketParams[2], 
      irm: marketParams[3],
      lltv: marketParams[4]
    };
    
    // Get market status
    let marketStatus;
    try {
      marketStatus = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "market",
        args: [marketId as `0x${string}`]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch market status. The market might be new or not configured properly.");
      marketStatus = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
        lastUpdate: 0n,
        fee: 0n
      };
    }
    
    // Get collateral token information
    const collateralTokenAddress = marketParams[1]; // Index 1 contains collateral token address
    console.log("Collateral Token Address: ", collateralTokenAddress);
    
    // Get collateral token info (symbol and decimals)
    const [collateralTokenSymbol, tokenDecimals] = await Promise.all([
      publicClient.readContract({
        address: collateralTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "symbol"
      }),
      publicClient.readContract({
        address: collateralTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals"
      })
    ]);
    
    console.log(`Collateral Token: ${collateralTokenSymbol}, Decimals: ${tokenDecimals}`);
    
    // Get the user's current collateral position
    const userPosition = await publicClient.readContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [marketId as `0x${string}`, account.address]
    });
    
    // Get the user's current balance
    const userBalance = await publicClient.readContract({
      address: collateralTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });
    
    // Convert the string amount to BigInt with proper decimals
    const collateralAmountBigInt = parseUnits(collateralAmount, tokenDecimals as number);
    
    // Display market and collateral information
    console.log("\n======= Market Information =======");
    console.log(`Market ID: ${marketId}`);
    console.log(`Loan Token: ${marketParams[0]}`);
    console.log(`Collateral Token: ${collateralTokenAddress} (${collateralTokenSymbol})`);
    console.log(`Collateral Token Decimals: ${tokenDecimals}`);
    console.log(`Oracle: ${marketParams[2]}`);
    console.log(`IRM: ${marketParams[3]}`);
    console.log(`LLTV: ${formatUnits(marketParams[4], 18)}`);
    console.log("\n======= Market Status =======");
    console.log(`Total Supply Assets: ${formatUnits(marketStatus[0], tokenDecimals as number)}`);
    console.log(`Total Borrow Assets: ${formatUnits(marketStatus[1], tokenDecimals as number)}`);
    console.log(`Supply Shares: ${formatUnits(marketStatus[2], tokenDecimals as number)}`);
    console.log(`Borrow Shares: ${formatUnits(marketStatus[3], tokenDecimals as number)}`);
    console.log(`Market Fee: ${Number(marketStatus[4]), 18}%`);
    console.log(`Last Update: ${marketStatus[5]}`);
    console.log("\n======= Your Position =======");
    // console.log(`Current Collateral: ${formatUnits(userPosition[0], tokenDecimals)} ${collateralTokenSymbol}`);
    console.log(`Supply Shares: ${formatUnits(userPosition[1], tokenDecimals as number)}`);
    console.log(`Borrow Shares: ${formatUnits(userPosition[2], tokenDecimals as number)}`);
    console.log("\n======= Supply Information =======");
    console.log(`Your ${collateralTokenSymbol} Balance: ${formatUnits(userBalance, tokenDecimals as number)} ${collateralTokenSymbol}`);
    console.log(`Amount to Supply as Collateral: ${collateralAmount} ${collateralTokenSymbol}`);
    console.log("==================================\n");
    
    // Check if user has enough balance
    if (userBalance < collateralAmountBigInt) {
      throw new Error(`Insufficient balance. You have ${formatUnits(userBalance, tokenDecimals as number)} ${collateralTokenSymbol}, but trying to supply ${collateralAmount} ${collateralTokenSymbol}.`);
    }
    
    // Check current allowance
    const currentAllowance = await publicClient.readContract({
      address: collateralTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, morphoAddress]
    });
    
    // Approve Morpho to spend tokens if needed
    if (currentAllowance < collateralAmountBigInt) {
      console.log(`Approving ${morphoAddress} to spend ${collateralAmount} ${collateralTokenSymbol}...`);
      
      const approveHash = await walletClient.writeContract({
        address: collateralTokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [morphoAddress as `0x${string}`, collateralAmountBigInt]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    } else {
      console.log("Token allowance is already sufficient.");
    }
    
    // Confirm supply action
    const confirm = await question(`Do you want to supply ${collateralAmount} ${collateralTokenSymbol} as collateral to market ${marketId}? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Supply cancelled by user.");
      return;
    }
    
    // Supply collateral
    console.log(`Supplying ${collateralAmount} ${collateralTokenSymbol} as collateral...`);
    const supplyHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "supplyCollateral",
      args: [
        marketParamsTuple,
        collateralAmountBigInt,
        account.address,
        "0x" // Empty data
      ]
    });
    
    console.log("Supply transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: supplyHash });
    
    console.log("✅ Collateral supply successful!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Get updated position
    const newPosition = await publicClient.readContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [marketId as `0x${string}`, account.address]
    });
    
    // Get updated balances
    const newBalance = await publicClient.readContract({
      address: collateralTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });
    
    console.log("\n======= Post-Supply Status =======");
    console.log(`New Supply Share Position: ${formatUnits(newPosition[1], tokenDecimals as number)} ${collateralTokenSymbol}`);
    console.log(`New ${collateralTokenSymbol} Balance: ${formatUnits(newBalance, tokenDecimals as number)} ${collateralTokenSymbol}`);
    console.log("==================================");
    
    console.log("\n🎉 Your collateral has been successfully supplied to the market!");
    console.log("You can now take loans against this collateral.");
    
  } catch (error) {
    console.error("Error supplying collateral:", error);
  }
}

supplyCollateral()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });