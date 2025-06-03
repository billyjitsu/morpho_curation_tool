import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, walletClient, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';
import * as readline from 'readline';

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let repayAmount = process.env.REPAY_AMOUNT || "0.005";
let repayAll = process.env.REPAY_ALL === "true" || false;
// let tokenDecimals = parseInt(process.env.TOKEN_DECIMALS || "18");
let onBehalf = process.env.ON_BEHALF || "";
let validateOracle = false;

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

// Fetch token information (symbol, name, decimals) from a contract
async function fetchTokenInfo(
  tokenAddress: Address,
  publicClient: PublicClient
): Promise<TokenInfo> {
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
      publicClient
        .readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "name",
        })
        .catch(() => "Unknown Token"), // Name is optional
    ]);

    return {
      address: tokenAddress,
      symbol: symbol as string,
      decimals: decimals as number,
      name: name as string,
    };
  } catch (error) {
    console.error(`Error fetching info for token ${tokenAddress}:`, error);
    return {
      address: tokenAddress,
      symbol: "UNKNOWN",
      decimals: 18,
      name: "Unknown Token",
    };
  }
}

// Validate oracle price and provide human-readable information
async function validateOraclePrice(
  oracleAddress: Address,
  loanToken: TokenInfo,
  collateralToken: TokenInfo,
  publicClient: PublicClient
): Promise<bigint> {
  console.log("\n======= Oracle Validation =======");
  console.log(`Oracle Address: ${oracleAddress}`);
  
  try {
    // Try to fetch the oracle price using both methods
    let rawPrice: bigint;
    
    try {
      // First try with token addresses (if both are available)
      rawPrice = await publicClient.readContract({
        address: oracleAddress,
        abi: parseAbi(["function price(address loanToken, address collateralToken) view returns (uint256)"]),  // ORACLE_ABI,
        functionName: "price",
        args: [loanToken.address, collateralToken.address]
      }) as bigint;
    } catch (error) {
      console.log("Could not read oracle");
    }

    console.log(`Raw oracle price: ${rawPrice}`);
    
    // Calculate human-readable price
    const decimalAdjustment = 36 + loanToken.decimals - collateralToken.decimals;
    const adjustedPrice = Number(formatUnits(rawPrice, decimalAdjustment));
    
    console.log(`Human-Readable Price:`);
    console.log(`1 ${collateralToken.symbol} = ${adjustedPrice} ${loanToken.symbol}`);
    console.log(`1 ${loanToken.symbol} = ${1 / adjustedPrice} ${collateralToken.symbol}`);
    console.log("==================================\n");
    
    return rawPrice;
  } catch (error) {
    console.error("Error validating oracle price:", error);
    throw new Error("Failed to validate oracle price");
  }
}

// Calculate borrower's debt in assets (accounting for accrued interest)
async function calculateCurrentDebt(
  borrowShares: bigint,
  totalBorrowShares: bigint,
  totalBorrowAssets: bigint
): Promise<bigint> {
  if (totalBorrowShares === 0n) return 0n;
  
  // Formula: borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares
  return (borrowShares * totalBorrowAssets) / totalBorrowShares;
}

async function repayLoan() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with MARKET_ID environment variable.");
  }
  if (repayAmount === "0" && !repayAll) {
    throw new Error("Repay amount is required. Configure via environment variables.");
  }

  // If onBehalf is not set, use the wallet's address
  if (!onBehalf) {
    onBehalf = account.address;
  }

  try {
    console.log("Getting market information...");
    
    // Get market parameters
    let loanToken: Address, collateralToken: Address, oracle: Address, irm: Address, lltv: bigint;
    try {
      const marketParamsResult = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "idToMarketParams",
        args: [marketId as `0x${string}`]
      });
      
      // Extract the values from the result 
      if (Array.isArray(marketParamsResult)) {
        [loanToken, collateralToken, oracle, irm, lltv] = marketParamsResult;
      } else if (typeof marketParamsResult === 'object') {
        ({ loanToken, collateralToken, oracle, irm, lltv } = marketParamsResult as any);
      }
      
      if (!loanToken || !collateralToken || !oracle || !irm || !lltv) {
        throw new Error("Invalid market parameters returned from contract");
      }
      
      console.log("✅ Market exists!");
      console.log("Market parameters:", { loanToken, collateralToken, oracle, irm, lltv: lltv.toString() });
    } catch (error) {
      console.error("❌ Market does not exist or couldn't be fetched. Make sure the market ID is correct.");
      throw error;
    }
    
    // Get token information
    const loanTokenInfo = await fetchTokenInfo(loanToken, publicClient);
    const collateralTokenInfo = await fetchTokenInfo(collateralToken, publicClient);
    console.log(`Loan Token: ${loanTokenInfo.name} (${loanTokenInfo.symbol}), decimals: ${loanTokenInfo.decimals}`);
    console.log(`Collateral Token: ${collateralTokenInfo.name} (${collateralTokenInfo.symbol}), decimals: ${collateralTokenInfo.decimals}`);
    
    // Update tokenDecimals
    let tokenDecimals = loanTokenInfo.decimals;
    
    // Get market status
    let totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee;
    try {
      const marketResult = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "market",
        args: [marketId as `0x${string}`]
      });
      
      if (Array.isArray(marketResult)) {
        [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketResult;
      } else if (typeof marketResult === 'object') {
        ({ totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee } = marketResult as any);
      }
      
    } catch (error) {
      console.warn("⚠️ Could not fetch market status. The market might be new or not configured properly.");
      totalSupplyAssets = 0n;
      totalSupplyShares = 0n;
      totalBorrowAssets = 0n;
      totalBorrowShares = 0n;
      lastUpdate = 0n;
      fee = 0n;
    }
    
    // Get the user's current position (the address for which we're repaying)
    let supplyShares, borrowShares, collateralAmount;
    try {
      const positionResult = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [marketId as `0x${string}`, onBehalf as `0x${string}`]
      });
      
      if (Array.isArray(positionResult)) {
        [supplyShares, borrowShares, collateralAmount] = positionResult;
      } else if (typeof positionResult === 'object') {
        ({ supplyShares, borrowShares, collateral: collateralAmount } = positionResult as any);
      }
    } catch (error) {
      console.warn("⚠️ Could not fetch user position. Using default values.");
      supplyShares = 0n;
      borrowShares = 0n;
      collateralAmount = 0n;
    }
    
    // Calculate current debt with accrued interest
    const currentDebt = await calculateCurrentDebt(borrowShares, totalBorrowShares, totalBorrowAssets);
    
    if (borrowShares === 0n || currentDebt === 0n) {
      console.log(`❌ The address ${onBehalf} has no debt in this market.`);
      return;
    }
    
    // If repayAll flag is set, set repayAmount to the current debt
    let repayAmountBigInt: bigint;
    if (repayAll) {
      console.log(`Repaying full debt of ${formatUnits(currentDebt, tokenDecimals)} ${loanTokenInfo.symbol}`);
      repayAmountBigInt = currentDebt;
      repayAmount = formatUnits(currentDebt, tokenDecimals);
    } else {
      repayAmountBigInt = parseUnits(repayAmount, tokenDecimals);
      
      // Check if repay amount is greater than current debt
      if (repayAmountBigInt > currentDebt) {
        console.log(`⚠️ Warning: Specified repay amount (${repayAmount} ${loanTokenInfo.symbol}) exceeds current debt (${formatUnits(currentDebt, tokenDecimals)} ${loanTokenInfo.symbol}).`);
        const useCurrentDebt = await question("Would you like to repay only the current debt instead? (y/n): ");
        if (useCurrentDebt.toLowerCase() === "y") {
          repayAmountBigInt = currentDebt;
          repayAmount = formatUnits(currentDebt, tokenDecimals);
          console.log(`Setting repay amount to current debt: ${repayAmount} ${loanTokenInfo.symbol}`);
        }
      }
    }
    
    // Check token balance and approval
    const userBalance = await publicClient.readContract({
      address: loanToken as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    }) as bigint;
    
    if (userBalance < repayAmountBigInt) {
      console.log(`❌ Insufficient balance to repay debt. You have ${formatUnits(userBalance, tokenDecimals)} ${loanTokenInfo.symbol} but need ${repayAmount} ${loanTokenInfo.symbol}.`);
      return;
    }
    
    // Validate oracle if requested
    if (validateOracle) {
      try {
        await validateOraclePrice(
          oracle as Address, 
          loanTokenInfo, 
          collateralTokenInfo, 
          publicClient
        );
      } catch (error) {
        console.warn("⚠️ Oracle validation failed but continuing with repayment.");
      }
    }
    
    // Display repayment information
    console.log("\n======= Debt Information =======");
    console.log(`Borrower: ${onBehalf}`);
    console.log(`Current Borrow Shares: ${formatUnits(borrowShares, tokenDecimals)}`);
    console.log(`Current Debt with Interest: ${formatUnits(currentDebt, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Collateral: ${formatUnits(collateralAmount, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    console.log("\n======= Repayment Information =======");
    console.log(`Amount to Repay: ${repayAmount} ${loanTokenInfo.symbol}`);
    console.log(`Your Balance: ${formatUnits(userBalance, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log("==================================\n");
    
    // Confirm repayment action
    const confirm = await question(`Do you want to repay ${repayAmount} ${loanTokenInfo.symbol} for ${onBehalf}? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Repayment operation cancelled by user.");
      return;
    }
    
    // Check and set approval if needed
    const allowance = await publicClient.readContract({
      address: loanToken as `0x${string}`,
      abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
      functionName: "allowance",
      args: [account.address, morphoAddress]
    }) as bigint;
    
    if (allowance < repayAmountBigInt) {
      console.log(`Setting approval for ${morphoAddress} to spend ${repayAmount} ${loanTokenInfo.symbol}...`);
      const approveHash = await walletClient.writeContract({
        address: loanToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [morphoAddress as `0x${string}`, repayAmountBigInt]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    }
    
    // Prepare market params tuple for the repay function
    const marketParamsTuple = {
      loanToken: loanToken as `0x${string}`,
      collateralToken: collateralToken as `0x${string}`,
      oracle: oracle as `0x${string}`,
      irm: irm as `0x${string}`,
      lltv: lltv
    };
    
    // Execute repayment
    console.log(`Repaying ${repayAmount} ${loanTokenInfo.symbol} for ${onBehalf}...`);
    const repayHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "repay",
      args: [
        marketParamsTuple, // Pass the market params object
        repayAmountBigInt, // assets
        0n, // shares (0 since we're specifying assets)
        onBehalf as `0x${string}`, // onBehalf
        "0x" // data (empty bytes)
      ]
    });
    
    console.log("Repayment transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: repayHash });
    
    console.log("✅ Repayment successful!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Get updated position
    let newPosition;
    try {
      newPosition = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [marketId as `0x${string}`, onBehalf as `0x${string}`]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch updated position.");
      newPosition = null;
    }
    
    // Get updated loan token balance
    let newBalance;
    try {
      newBalance = await publicClient.readContract({
        address: loanToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch updated balance.");
      newBalance = null;
    }
    
    console.log("\n======= Post-Repayment Status =======");
    if (newPosition) {
      const newBorrowShares = Array.isArray(newPosition) ? newPosition[1] : (newPosition as any).borrowShares;
      console.log(`New Borrow Position: ${formatUnits(newBorrowShares, tokenDecimals)} shares`);
      
      if (newBorrowShares === 0n) {
        console.log("🎉 Debt fully repaid!");
      } else {
        // Calculate remaining debt
        const updatedMarket = await publicClient.readContract({
          address: morphoAddress as `0x${string}`,
          abi: MORPHO_ABI,
          functionName: "market",
          args: [marketId as `0x${string}`]
        });
        
        const updatedTotalBorrowShares = Array.isArray(updatedMarket) ? updatedMarket[3] : (updatedMarket as any).totalBorrowShares;
        const updatedTotalBorrowAssets = Array.isArray(updatedMarket) ? updatedMarket[2] : (updatedMarket as any).totalBorrowAssets;
        
        const remainingDebt = await calculateCurrentDebt(newBorrowShares, updatedTotalBorrowShares, updatedTotalBorrowAssets);
        console.log(`Remaining Debt: ${formatUnits(remainingDebt, tokenDecimals)} ${loanTokenInfo.symbol}`);
      }
    }
    if (newBalance) {
      console.log(`New ${loanTokenInfo.symbol} Balance: ${formatUnits(newBalance, tokenDecimals)} ${loanTokenInfo.symbol}`);
    }
    console.log("===================================");
    
  } catch (error) {
    console.error("Error repaying loan:", error);
  }
}

repayLoan()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });