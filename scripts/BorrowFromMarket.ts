import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, createWalletByIndex, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO from './abis/morpho.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let borrowAmount = process.env.BORROW_AMOUNT || "0.5";
let receiver = process.env.RECEIVER || "";
let oraclePrice = process.env.ORACLE_PRICE ? BigInt(process.env.ORACLE_PRICE) : 0n;
let validateOracle = false;

// Define token information type
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
        .catch(() => "Unknown Token"), 
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
      // Try with token addresses
      rawPrice = await publicClient.readContract({
        address: oracleAddress,
        abi: parseAbi(["function price(address loanToken, address collateralToken) view returns (uint256)"]),
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

// Calculate max borrowable amount based on collateral, LLTV, and oracle price
function calculateMaxBorrowable(
  collateralAmount: bigint,
  lltv: bigint,
  oraclePrice: bigint,
  loanToken: TokenInfo,
  collateralToken: TokenInfo
): bigint {
  // The max borrowable is: collateralAmount * oraclePrice * LLTV / 1e18
  // We need to adjust for different token decimals
  // Oracle price already adjusts for token decimal differences
  const WAD = 10n ** 18n;
  
  // Adjusted calculation to account for the 36 decimal scaling in oracle price
  const adjustmentFactor = 10n ** BigInt(36); // Oracle uses 36 decimals of precision
  return (collateralAmount * oraclePrice * lltv) / (WAD * adjustmentFactor);
}

async function borrowFromMarket() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with --morpho=0x... or in MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with --marketId=0x... or in MARKET_ID environment variable.");
  }
  if (borrowAmount === "0") {
    throw new Error("Borrow amount is required. Set it with --amount=<amount> or in BORROW_AMOUNT environment variable.");
  }

  // Set receiver to the caller's address if not specified
  if (!receiver) {
    receiver = walletClient.account.address;
  }

  try {
    console.log("Getting market information...");
    
    // Get market parameters
    let loanToken: Address, collateralToken: Address, oracle: Address, irm: Address, lltv: bigint;
    try {
      const marketParamsResult = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO,
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
    
    // Get market status
    let totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee;
    try {
      const marketResult = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO,
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
        abi: MORPHO,
        functionName: "position",
        args: [marketId as `0x${string}`, walletClient.account.address]
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
    
    // Validate oracle price if requested
    if (validateOracle || oraclePrice === 0n) {
      try {
        oraclePrice = await validateOraclePrice(
          oracle as Address, 
          loanTokenInfo, 
          collateralTokenInfo, 
          publicClient
        );
        console.log(`Oracle price validated: ${oraclePrice}`);
      } catch (error) {
        if (oraclePrice === 0n) {
          console.warn("⚠️ Could not validate oracle price and no fallback provided. Using default 1:1 price.");
          oraclePrice = parseUnits("1", 36); // Default with 36 decimal places
        } else {
          console.warn(`⚠️ Oracle validation failed but using provided price: ${oraclePrice}`);
        }
      }
    } else if (oraclePrice === 0n) {
      // If validation not requested but no price provided, try to fetch it
      try {
        console.log("Fetching oracle price...");
        try {
          oraclePrice = await publicClient.readContract({
            address: oracle as `0x${string}`,
            abi: parseAbi(["function price(address loanToken, address collateralToken) view returns (uint256)"]),
            functionName: "price",
            args: [loanToken, collateralToken]
          }) as bigint;
        } catch {
          console.log("Could not fetch oracle price");
        }
        console.log(`Oracle price fetched: ${oraclePrice}`);
      } catch (error) {
        console.warn("⚠️ Could not fetch oracle price. Please provide it manually with --oraclePrice parameter.");
        oraclePrice = parseUnits("1", 36); // Default to 1:1 price ratio with 36 decimals
      }
    }
    
    // Calculate maximum borrowable amount based on collateral, LLTV, and oracle price
    const maxBorrowable = calculateMaxBorrowable(
      collateralAmount, 
      lltv, 
      oraclePrice,
      loanTokenInfo,
      collateralTokenInfo
    );
    
    // Convert the string amount to BigInt with proper decimals
    const borrowAmountBigInt = parseUnits(borrowAmount, loanTokenInfo.decimals);
    
    // Display market and borrow information
    console.log("\n======= Market Information =======");
    console.log(`Market ID: ${marketId}`);
    console.log(`Loan Token: ${loanTokenInfo.name} (${loanTokenInfo.symbol})`);
    console.log(`Collateral Token: ${collateralTokenInfo.name} (${collateralTokenInfo.symbol})`);
    console.log(`Oracle: ${oracle}`);
    console.log(`IRM: ${irm}`);
    console.log(`LLTV: ${formatUnits(lltv, 18)}`);
    console.log("\n======= Market Status =======");
    console.log(`Total Supply Assets: ${formatUnits(totalSupplyAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Total Borrow Assets: ${formatUnits(totalBorrowAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Available Liquidity: ${formatUnits(totalSupplyAssets - totalBorrowAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Market Fee: ${Number(fee) / 10000}%`); // Assuming fee is in basis points (1/100 of a percent)
    console.log("\n======= Your Position =======");
    console.log(`Current Collateral: ${formatUnits(collateralAmount, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    console.log(`Current Borrow: ${formatUnits(borrowShares, loanTokenInfo.decimals)} shares`);
    console.log(`Oracle Price: ${formatUnits(oraclePrice, 36)}`);
    console.log(`Calculated Maximum Borrowable: ${formatUnits(maxBorrowable, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log("\n======= Borrow Information =======");
    console.log(`Amount to Borrow: ${borrowAmount} ${loanTokenInfo.symbol}`);
    console.log(`Receiving Address: ${receiver}`);
    console.log("==================================\n");
    
    // Check if the user has enough borrowable capacity
    if (borrowAmountBigInt > maxBorrowable) {
      console.log(`⚠️ Warning: Requested borrow amount (${borrowAmount} ${loanTokenInfo.symbol}) exceeds your maximum borrowable amount (${formatUnits(maxBorrowable, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}).`);
      
      if (maxBorrowable === 0n) {
        console.log("❌ You cannot borrow any funds. Make sure you have supplied enough collateral first.");
        return;
      }
      
      const useMax = await question("Would you like to borrow the maximum available amount instead? (y/n): ");
      if (useMax.toLowerCase() === "y") {
        console.log(`Setting borrow amount to maximum: ${formatUnits(maxBorrowable, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
        borrowAmount = formatUnits(maxBorrowable, loanTokenInfo.decimals);
        borrowAmountBigInt = maxBorrowable;
      } else {
        console.log("Borrow operation cancelled.");
        return;
      }
    }
    
    // Check if there's enough liquidity in the market
    const availableLiquidity = totalSupplyAssets - totalBorrowAssets;
    if (borrowAmountBigInt > availableLiquidity) {
      console.log(`⚠️ Warning: Requested borrow amount (${borrowAmount} ${loanTokenInfo.symbol}) exceeds the available liquidity in the market (${formatUnits(availableLiquidity, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}).`);
      
      if (availableLiquidity === 0n) {
        console.log("❌ There is no liquidity available in the market. Please try again later when the market has liquidity.");
        return;
      }
      
      const useAvailable = await question("Would you like to borrow the maximum available liquidity instead? (y/n): ");
      if (useAvailable.toLowerCase() === "y") {
        console.log(`Setting borrow amount to available liquidity: ${formatUnits(availableLiquidity, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
        borrowAmount = formatUnits(availableLiquidity, loanTokenInfo.decimals);
        borrowAmountBigInt = availableLiquidity;
      } else {
        console.log("Borrow operation cancelled.");
        return;
      }
    }
    
    // Confirm borrow action
    const confirm = await question(`Do you want to borrow ${borrowAmount} ${loanTokenInfo.symbol} from market ${marketId}? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y') {
      console.log("Borrow operation cancelled by user.");
      return;
    }
    
    // Prepare market params tuple for the borrow function
    const marketParamsTuple = {
      loanToken: loanToken as `0x${string}`,
      collateralToken: collateralToken as `0x${string}`,
      oracle: oracle as `0x${string}`,
      irm: irm as `0x${string}`,
      lltv: lltv
    };
    
    // Execute borrow
    console.log(`Borrowing ${borrowAmount} ${loanTokenInfo.symbol}...`);
    const borrowHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO,
      functionName: "borrow",
      args: [
        marketParamsTuple, // Pass the market params object
        borrowAmountBigInt, // assets
        0n, // shares (0 since we're specifying assets)
        walletClient.account.address, // onBehalf
        receiver as `0x${string}` // receiver
      ]
    });
    
    console.log("Borrow transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: borrowHash });
    
    console.log("✅ Borrow successful!");
    console.log("Transaction hash:", receipt.transactionHash);
    
    // Get updated position
    let newPosition;
    try {
      newPosition = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO,
        functionName: "position",
        args: [marketId as `0x${string}`, walletClient.account.address]
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
        args: [receiver as `0x${string}`]
      });
    } catch (error) {
      console.warn("⚠️ Could not fetch updated balance.");
      newBalance = null;
    }
    
    console.log("\n======= Post-Borrow Status =======");
    if (newPosition) {
      const newBorrowShares = Array.isArray(newPosition) ? newPosition[1] : (newPosition as any).borrowShares;
      console.log(`New Borrow Position: ${formatUnits(newBorrowShares, loanTokenInfo.decimals)} shares`);
    }
    if (newBalance) {
      console.log(`New ${loanTokenInfo.symbol} Balance of Receiver: ${formatUnits(newBalance, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    }
    console.log("===================================");
    
    console.log("\n🎉 Your loan has been successfully taken!");
    console.log("Remember to monitor your position and repay the loan to avoid liquidation.");
    
  } catch (error) {
    console.error("Error borrowing from market:", error);
  }
}

borrowFromMarket()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });