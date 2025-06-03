import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, walletClient, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';
import * as readline from 'readline';

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let supplyAmount = process.env.SUPPLY_AMOUNT || "1";
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
    // Try to fetch the oracle price
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

async function supplyToMarket() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with MARKET_ID environment variable.");
  }
  if (supplyAmount === "0") {
    throw new Error("Supply amount is required. Set it with SUPPLY_AMOUNT environment variable.");
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
    
    // Convert the string amount to BigInt with proper decimals
    const supplyAmountBigInt = parseUnits(supplyAmount, tokenDecimals);
    
    // Check token balance
    const userBalance = await publicClient.readContract({
      address: loanToken as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    }) as bigint;
    
    if (userBalance < supplyAmountBigInt) {
      console.log(`❌ Insufficient balance to supply. You have ${formatUnits(userBalance, tokenDecimals)} ${loanTokenInfo.symbol} but need ${supplyAmount} ${loanTokenInfo.symbol}.`);
      return;
    }
    
    // Calculate expected shares to receive (if market has existing supply)
    let expectedShares: bigint;
    if (totalSupplyAssets > 0n && totalSupplyShares > 0n) {
      // Formula: shares = assets * totalSupplyShares / totalSupplyAssets
      expectedShares = (supplyAmountBigInt * totalSupplyShares) / totalSupplyAssets;
    } else {
      // First supply to market - shares = assets (1:1 ratio)
      expectedShares = supplyAmountBigInt;
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
        console.warn("⚠️ Oracle validation failed but continuing with supply.");
      }
    }
    
    // Display supply information
    console.log("\n======= Market Information =======");
    console.log(`Market ID: ${marketId}`);
    console.log(`Loan Token: ${loanTokenInfo.symbol} (${loanToken})`);
    console.log(`Collateral Token: ${collateralTokenInfo.symbol} (${collateralToken})`);
    console.log(`LLTV: ${formatUnits(lltv, 18)} (${(Number(formatUnits(lltv, 18)) * 100).toFixed(2)}%)`);
    console.log(`Total Supply Assets: ${formatUnits(totalSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Total Borrow Assets: ${formatUnits(totalBorrowAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    
    console.log("\n======= Your Current Position =======");
    console.log(`Supply Shares: ${formatUnits(supplyShares, tokenDecimals)}`);
    console.log(`Borrow Shares: ${formatUnits(borrowShares, tokenDecimals)}`);
    console.log(`Collateral: ${formatUnits(collateralAmount, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    
    console.log("\n======= Supply Information =======");
    console.log(`Supplier: ${onBehalf}`);
    console.log(`Amount to Supply: ${supplyAmount} ${loanTokenInfo.symbol}`);
    console.log(`Your Balance: ${formatUnits(userBalance, tokenDecimals)} ${loanTokenInfo.symbol}`);
    console.log(`Expected Shares to Receive: ${formatUnits(expectedShares, tokenDecimals)}`);
    console.log("==================================\n");
    
    // Confirm supply action
    const confirm = await question(`Do you want to supply ${supplyAmount} ${loanTokenInfo.symbol} to this market? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Supply operation cancelled by user.");
      return;
    }
    
    // Check and set approval if needed
    const allowance = await publicClient.readContract({
      address: loanToken as `0x${string}`,
      abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
      functionName: "allowance",
      args: [account.address, morphoAddress]
    }) as bigint;
    
    if (allowance < supplyAmountBigInt) {
      console.log(`Setting approval for ${morphoAddress} to spend ${supplyAmount} ${loanTokenInfo.symbol}...`);
      const approveHash = await walletClient.writeContract({
        address: loanToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [morphoAddress as `0x${string}`, supplyAmountBigInt]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    }
    
    // Prepare market params tuple for the supply function
    const marketParamsTuple = {
      loanToken: loanToken as `0x${string}`,
      collateralToken: collateralToken as `0x${string}`,
      oracle: oracle as `0x${string}`,
      irm: irm as `0x${string}`,
      lltv: lltv
    };
    
    // Execute supply
    console.log(`Supplying ${supplyAmount} ${loanTokenInfo.symbol} to market...`);
    const supplyHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "supply",
      args: [
        marketParamsTuple, // Market parameters
        supplyAmountBigInt, // assets to supply
        0n, // shares (0 since we're specifying assets)
        onBehalf as `0x${string}`, // onBehalf (who receives the shares)
        "0x" // data (empty bytes for additional callback data)
      ]
    });
    
    console.log("Supply transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: supplyHash });
    
    console.log("✅ Supply successful!");
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
    
    console.log("\n======= Post-Supply Status =======");
    if (newPosition) {
      const newSupplyShares = Array.isArray(newPosition) ? newPosition[0] : (newPosition as any).supplyShares;
      console.log(`New Supply Shares: ${formatUnits(newSupplyShares, tokenDecimals)}`);
      console.log(`Shares Gained: ${formatUnits(newSupplyShares - supplyShares, tokenDecimals)}`);
    }
    if (newMarketStatus) {
      const newTotalSupplyAssets = Array.isArray(newMarketStatus) ? newMarketStatus[0] : (newMarketStatus as any).totalSupplyAssets;
      console.log(`New Market Total Supply: ${formatUnits(newTotalSupplyAssets, tokenDecimals)} ${loanTokenInfo.symbol}`);
    }
    if (newBalance) {
      console.log(`New ${loanTokenInfo.symbol} Balance: ${formatUnits(newBalance, tokenDecimals)} ${loanTokenInfo.symbol}`);
    }
    console.log("===================================");
    
  } catch (error) {
    console.error("Error supplying to market:", error);
  }
}

supplyToMarket()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });