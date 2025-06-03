import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, walletClient, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';
import * as readline from 'readline';

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let withdrawAmount = process.env.WITHDRAW_AMOUNT || "0.5";
let withdrawAll = process.env.WITHDRAW_ALL === "true" || false;
let onBehalf = process.env.ON_BEHALF || "";
let receiver = process.env.RECEIVER || "";
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
    let rawPrice: bigint;
    
    try {
      rawPrice = await publicClient.readContract({
        address: oracleAddress,
        abi: parseAbi(["function price(address loanToken, address collateralToken) view returns (uint256)"]),
        functionName: "price",
        args: [loanToken.address, collateralToken.address]
      }) as bigint;
    } catch (error) {
      console.log("Could not read oracle price");
      throw error;
    }

    console.log(`Raw oracle price: ${rawPrice}`);
    
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

// Calculate current supply assets from shares
async function calculateSupplyAssets(
  supplyShares: bigint,
  totalSupplyShares: bigint,
  totalSupplyAssets: bigint
): Promise<bigint> {
  if (totalSupplyShares === 0n) return 0n;
  
  // Formula: supplyAssets = supplyShares * totalSupplyAssets / totalSupplyShares
  return (supplyShares * totalSupplyAssets) / totalSupplyShares;
}

async function withdrawFromMarket() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with MARKET_ID environment variable.");
  }
  if (withdrawAmount === "0" && !withdrawAll) {
    throw new Error("Withdraw amount is required. Configure via environment variables.");
  }

  // If onBehalf is not set, use the wallet's address
  if (!onBehalf) {
    onBehalf = account.address;
  }

  // If receiver is not set, use the wallet's address
  if (!receiver) {
    receiver = account.address;
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
      console.warn("⚠️ Could not fetch market status.");
      totalSupplyAssets = 0n;
      totalSupplyShares = 0n;
      totalBorrowAssets = 0n;
      totalBorrowShares = 0n;
      lastUpdate = 0n;
      fee = 0n;
    }
    
    // Get the user's current position
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
    
    // Calculate current supply assets with accrued interest
    const currentSupplyAssets = await calculateSupplyAssets(supplyShares, totalSupplyShares, totalSupplyAssets);
    
    if (supplyShares === 0n || currentSupplyAssets === 0n) {
      console.log(`❌ The address ${onBehalf} has no supply position in this market.`);
      return;
    }
    
    // If withdrawAll flag is set, set withdrawAmount to the current supply
    let withdrawAmountBigInt: bigint;
    if (withdrawAll) {
      console.log(`Withdrawing all supplied assets: ${formatUnits(currentSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
      withdrawAmountBigInt = currentSupplyAssets;
      withdrawAmount = formatUnits(currentSupplyAssets, tokenDecimals);
    } else {
      withdrawAmountBigInt = parseUnits(withdrawAmount, tokenDecimals);
      
      // Check if withdraw amount is greater than current supply
      if (withdrawAmountBigInt > currentSupplyAssets) {
        console.log(`⚠️ Warning: Specified withdraw amount (${withdrawAmount} ${loanTokenInfo.symbol}) exceeds current supply (${formatUnits(currentSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}).`);
        const useCurrentSupply = await question("Would you like to withdraw only the available supply instead? (y/n): ");
        if (useCurrentSupply.toLowerCase() === "y") {
          withdrawAmountBigInt = currentSupplyAssets;
          withdrawAmount = formatUnits(currentSupplyAssets, tokenDecimals);
          console.log(`Setting withdraw amount to current supply: ${withdrawAmount} ${loanTokenInfo.symbol}`);
        } else {
          console.log("Withdrawal cancelled.");
          return;
        }
      }
    }
    
    // Check if there's enough liquidity in the market for withdrawal
    const availableLiquidity = totalSupplyAssets - totalBorrowAssets;
    if (withdrawAmountBigInt > availableLiquidity) {
      console.log(`❌ Insufficient liquidity in market. Available: ${formatUnits(availableLiquidity, tokenDecimals)} ${loanTokenInfo.symbol}, Requested: ${withdrawAmount} ${loanTokenInfo.symbol}`);
      console.log("💡 Tip: Wait for borrowers to repay or consider withdrawing a smaller amount.");
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
        console.warn("⚠️ Oracle validation failed but continuing with withdrawal.");
      }
    }
    
    // Calculate shares that will be burned
    let sharesToBurn: bigint;
    if (withdrawAmountBigInt >= currentSupplyAssets) {
      // Withdrawing all - burn all shares
      sharesToBurn = supplyShares;
    } else {
      // Calculate shares proportionally
      sharesToBurn = (withdrawAmountBigInt * supplyShares) / currentSupplyAssets;
    }
    
    // Display withdrawal information
    console.log("\n======= Market Information =======");
    console.log(`Market ID: ${marketId}`);
    console.log(`Loan Token: ${loanTokenInfo.symbol} (${loanToken})`);
    console.log(`Collateral Token: ${collateralTokenInfo.symbol} (${collateralToken})`);
    console.log(`LLTV: ${formatUnits(lltv, 18)} (${(Number(formatUnits(lltv, 18)) * 100).toFixed(2)}%)`);
    console.log(`Total Supply Assets: ${formatUnits(totalSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Total Borrow Assets: ${formatUnits(totalBorrowAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Available Liquidity: ${formatUnits(availableLiquidity, tokenDecimals)} ${loanTokenInfo.symbol}`);
    
    console.log("\n======= Your Current Position =======");
    console.log(`Supply Shares: ${formatUnits(supplyShares, tokenDecimals)}`);
    console.log(`Current Supply Value: ${formatUnits(currentSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Borrow Shares: ${formatUnits(borrowShares, tokenDecimals)}`);
    console.log(`Collateral: ${formatUnits(collateralAmount, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    
    console.log("\n======= Withdrawal Information =======");
    console.log(`Withdrawing from: ${onBehalf}`);
    console.log(`Receiving to: ${receiver}`);
    console.log(`Amount to Withdraw: ${withdrawAmount} ${loanTokenInfo.symbol}`);
    console.log(`Shares to Burn: ${formatUnits(sharesToBurn, tokenDecimals)}`);
    console.log(`Remaining Supply after Withdrawal: ${formatUnits(currentSupplyAssets - withdrawAmountBigInt, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log("==================================\n");
    
    // Check if user has authorization to withdraw on behalf of another address
    if (onBehalf.toLowerCase() !== account.address.toLowerCase()) {
      const isAuthorized = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "isAuthorized",
        args: [onBehalf as `0x${string}`, account.address]
      }) as boolean;
      
      if (!isAuthorized) {
        console.log(`❌ You are not authorized to withdraw on behalf of ${onBehalf}`);
        console.log("💡 The owner needs to call setAuthorization() first.");
        return;
      }
      console.log("✅ Authorization confirmed for withdrawal on behalf of another address.");
    }
    
    // Confirm withdrawal action
    const confirm = await question(`Do you want to withdraw ${withdrawAmount} ${loanTokenInfo.symbol} from this market? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Withdrawal operation cancelled by user.");
      return;
    }
    
    // Prepare market params tuple for the withdraw function
    const marketParamsTuple = {
      loanToken: loanToken as `0x${string}`,
      collateralToken: collateralToken as `0x${string}`,
      oracle: oracle as `0x${string}`,
      irm: irm as `0x${string}`,
      lltv: lltv
    };
    
    // Execute withdrawal
    console.log(`Withdrawing ${withdrawAmount} ${loanTokenInfo.symbol} from market...`);
    const withdrawHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "withdraw",
      args: [
        marketParamsTuple, // Market parameters
        withdrawAmountBigInt, // assets to withdraw
        0n, // shares (0 since we're specifying assets)
        onBehalf as `0x${string}`, // onBehalf (whose position to withdraw from)
        receiver as `0x${string}` // receiver (who gets the tokens)
      ]
    });
    
    console.log("Withdrawal transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
    
    console.log("✅ Withdrawal successful!");
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
    
    // Get updated market status
    let newMarketStatus;
    try {
      newMarketStatus = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "market",
        args: [marketId as `0x${string}`]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch updated market status.");
      newMarketStatus = null;
    }
    
    // Get updated loan token balance for receiver
    let newReceiverBalance;
    try {
      newReceiverBalance = await publicClient.readContract({
        address: loanToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [receiver as `0x${string}`]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch updated receiver balance.");
      newReceiverBalance = null;
    }
    
    console.log("\n======= Post-Withdrawal Status =======");
    if (newPosition) {
      const newSupplyShares = Array.isArray(newPosition) ? newPosition[0] : (newPosition as any).supplyShares;
      console.log(`New Supply Shares: ${formatUnits(newSupplyShares, tokenDecimals)}`);
      console.log(`Shares Burned: ${formatUnits(supplyShares - newSupplyShares, tokenDecimals)}`);
      
      if (newSupplyShares === 0n) {
        console.log("🎉 All supply withdrawn!");
      } else {
        // Calculate remaining supply value
        if (newMarketStatus) {
          const newTotalSupplyShares = Array.isArray(newMarketStatus) ? newMarketStatus[1] : (newMarketStatus as any).totalSupplyShares;
          const newTotalSupplyAssets = Array.isArray(newMarketStatus) ? newMarketStatus[0] : (newMarketStatus as any).totalSupplyAssets;
          
          const remainingSupplyAssets = await calculateSupplyAssets(newSupplyShares, newTotalSupplyShares, newTotalSupplyAssets);
          console.log(`Remaining Supply Value: ${formatUnits(remainingSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
        }
      }
    }
    if (newMarketStatus) {
      const newTotalSupplyAssets = Array.isArray(newMarketStatus) ? newMarketStatus[0] : (newMarketStatus as any).totalSupplyAssets;
      const newTotalBorrowAssets = Array.isArray(newMarketStatus) ? newMarketStatus[2] : (newMarketStatus as any).totalBorrowAssets;
      console.log(`New Market Total Supply: ${formatUnits(newTotalSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
      console.log(`New Available Liquidity: ${formatUnits(newTotalSupplyAssets - newTotalBorrowAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    }
    if (newReceiverBalance) {
      console.log(`Receiver's New ${loanTokenInfo.symbol} Balance: ${formatUnits(newReceiverBalance, tokenDecimals)} ${loanTokenInfo.symbol}`);
    }
    console.log("===================================");
    
  } catch (error) {
    console.error("Error withdrawing from market:", error);
  }
}

withdrawFromMarket()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });