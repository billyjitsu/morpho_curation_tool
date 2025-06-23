import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';

const walletClient = createWalletByIndex(0);

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let userAddress = process.env.USER_ADDRESS || walletClient.account.address;

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
  totalSupply?: bigint;
}

interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

interface UserPosition {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  supplyAssets?: bigint;
  borrowAssets?: bigint;
}

// Fetch token information
async function fetchTokenInfo(
  tokenAddress: Address,
  publicClient: PublicClient
): Promise<TokenInfo> {
  try {
    const [symbol, decimals, name, totalSupply] = await Promise.all([
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
      publicClient
        .readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "totalSupply",
        })
        .catch(() => 0n)
    ]);

    return {
      address: tokenAddress,
      symbol: symbol as string,
      decimals: decimals as number,
      name: name as string,
      totalSupply: totalSupply as bigint,
    };
  } catch (error) {
    console.error(`Error fetching info for token ${tokenAddress}:`, error);
    return {
      address: tokenAddress,
      symbol: "UNKNOWN",
      decimals: 18,
      name: "Unknown Token",
      totalSupply: 0n,
    };
  }
}

// Get oracle price with validation
async function getOraclePrice(
  oracleAddress: Address,
  loanToken: TokenInfo,
  collateralToken: TokenInfo,
  publicClient: PublicClient
): Promise<{ rawPrice: bigint; humanPrice: number; inverse: number } | null> {
  try {
    const rawPrice = await publicClient.readContract({
      address: oracleAddress,
      abi: parseAbi(["function price() external view returns (uint256)"]),
      functionName: "price",
    }) as bigint;

    const decimalAdjustment = 36 + loanToken.decimals - collateralToken.decimals;
    const humanPrice = Number(formatUnits(rawPrice, decimalAdjustment));
    
    return {
      rawPrice,
      humanPrice,
      inverse: 1 / humanPrice
    };
  } catch (error) {
    console.warn("Could not fetch oracle price:", error);
    return null;
  }
}

// Get Interest Rate Model information
async function getIrmInfo(
  irmAddress: Address,
  publicClient: PublicClient
): Promise<any> {
  try {
    // Try to get IRM name/type if available
    const irmInfo: any = { address: irmAddress };
    
    // Try common IRM function calls
    try {
      const borrowRate = await publicClient.readContract({
        address: irmAddress,
        abi: parseAbi(["function borrowRate(uint256 utilization) view returns (uint256)"]),
        functionName: "borrowRate",
        args: [parseUnits("0.8", 18)] // 80% utilization example
      });
      irmInfo.borrowRateAt80 = borrowRate;
    } catch {}
    
    try {
      const supplyRate = await publicClient.readContract({
        address: irmAddress,
        abi: parseAbi(["function supplyRate(uint256 utilization) view returns (uint256)"]),
        functionName: "supplyRate", 
        args: [parseUnits("0.8", 18)]
      });
      irmInfo.supplyRateAt80 = supplyRate;
    } catch {}

    return irmInfo;
  } catch (error) {
    return { address: irmAddress, error: "Could not fetch IRM info" };
  }
}

// Calculate utilization rate
function calculateUtilization(totalSupplyAssets: bigint, totalBorrowAssets: bigint): number {
  if (totalSupplyAssets === 0n) return 0;
  return Number(formatUnits((totalBorrowAssets * parseUnits("1", 18)) / totalSupplyAssets, 18));
}

// Calculate user's actual assets from shares
function calculateUserAssets(
  userShares: bigint,
  totalShares: bigint,
  totalAssets: bigint
): bigint {
  if (totalShares === 0n) return 0n;
  return (userShares * totalAssets) / totalShares;
}

// Calculate health factor (simplified)
function calculateHealthFactor(
  collateralValue: bigint,
  borrowValue: bigint,
  lltv: bigint
): number {
  if (borrowValue === 0n) return Infinity;
  
  const maxBorrowValue = (collateralValue * lltv) / parseUnits("1", 18);
  return Number(formatUnits(maxBorrowValue, 18)) / Number(formatUnits(borrowValue, 18));
}

// Calculate APY from rate (assuming rate is per second)
function calculateAPY(ratePerSecond: bigint): number {
  const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
  const rate = Number(formatUnits(ratePerSecond, 18));
  return (Math.pow(1 + rate, SECONDS_PER_YEAR) - 1) * 100;
}

async function getMarketInfo() {
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with MARKET_ID environment variable.");
  }

  try {
    console.log("🔍 Fetching comprehensive market information...\n");
    
    // Get market parameters
    let marketParams: MarketParams;
    try {
      const result = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "idToMarketParams",
        args: [marketId as `0x${string}`]
      });
      
      if (Array.isArray(result)) {
        const [loanToken, collateralToken, oracle, irm, lltv] = result;
        marketParams = { loanToken, collateralToken, oracle, irm, lltv };
      } else {
        marketParams = result as MarketParams;
      }
    } catch (error) {
      console.error("❌ Market does not exist or couldn't be fetched.");
      throw error;
    }

    // Get market state
    let marketState: MarketState;
    try {
      const result = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "market",
        args: [marketId as `0x${string}`]
      });
      
      if (Array.isArray(result)) {
        const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = result;
        marketState = { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
      } else {
        marketState = result as MarketState;
      }
    } catch (error) {
      console.warn("⚠️ Could not fetch market state.");
      marketState = {
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
        lastUpdate: 0n,
        fee: 0n
      };
    }

    // Get user position
    let userPosition: UserPosition;
    try {
      const result = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [marketId as `0x${string}`, userAddress as `0x${string}`]
      });
      
      if (Array.isArray(result)) {
        const [supplyShares, borrowShares, collateral] = result;
        userPosition = { supplyShares, borrowShares, collateral };
      } else {
        userPosition = result as UserPosition;
      }
      
      // Calculate actual asset amounts
      userPosition.supplyAssets = calculateUserAssets(
        userPosition.supplyShares,
        marketState.totalSupplyShares,
        marketState.totalSupplyAssets
      );
      userPosition.borrowAssets = calculateUserAssets(
        userPosition.borrowShares,
        marketState.totalBorrowShares,
        marketState.totalBorrowAssets
      );
    } catch (error) {
      userPosition = { supplyShares: 0n, borrowShares: 0n, collateral: 0n, supplyAssets: 0n, borrowAssets: 0n };
    }

    // Fetch token information
    const [loanTokenInfo, collateralTokenInfo] = await Promise.all([
      fetchTokenInfo(marketParams.loanToken, publicClient),
      fetchTokenInfo(marketParams.collateralToken, publicClient)
    ]);

    // Get oracle price
    const oraclePrice = await getOraclePrice(
      marketParams.oracle,
      loanTokenInfo,
      collateralTokenInfo,
      publicClient
    );

    // Get IRM information
    const irmInfo = await getIrmInfo(marketParams.irm, publicClient);

    // Calculate metrics
    const utilization = calculateUtilization(marketState.totalSupplyAssets, marketState.totalBorrowAssets);
    const availableLiquidity = marketState.totalSupplyAssets - marketState.totalBorrowAssets;
    
    // Calculate health factor for user
    let healthFactor = Infinity;
    if (oraclePrice && userPosition.collateral > 0n && userPosition.borrowAssets! > 0n) {
      const collateralValueInLoanToken = (userPosition.collateral * BigInt(Math.floor(oraclePrice.humanPrice * 1e18))) / parseUnits("1", 18);
      healthFactor = calculateHealthFactor(collateralValueInLoanToken, userPosition.borrowAssets!, marketParams.lltv);
    }

    // Display comprehensive information
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("🏛️  MORPHO MARKET COMPREHENSIVE INFORMATION");
    console.log("═══════════════════════════════════════════════════════════════");
    
    console.log("\n📋 BASIC MARKET INFORMATION");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`Market ID: ${marketId}`);
    console.log(`Morpho Protocol: ${morphoAddress}`);
    console.log(`Last Update: ${new Date(Number(marketState.lastUpdate) * 1000).toLocaleString()}`);
    console.log(`Market Fee: ${formatUnits(marketState.fee, 18)} (${(Number(formatUnits(marketState.fee, 18)) * 100).toFixed(4)}%)`);

    console.log("\n🏦 MARKET PARAMETERS");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`Loan Token: ${loanTokenInfo.name} (${loanTokenInfo.symbol})`);
    console.log(`  ├─ Address: ${marketParams.loanToken}`);
    console.log(`  ├─ Decimals: ${loanTokenInfo.decimals}`);
    console.log(`  └─ Total Supply: ${formatUnits(loanTokenInfo.totalSupply || 0n, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    
    console.log(`Collateral Token: ${collateralTokenInfo.name} (${collateralTokenInfo.symbol})`);
    console.log(`  ├─ Address: ${marketParams.collateralToken}`);
    console.log(`  ├─ Decimals: ${collateralTokenInfo.decimals}`);
    console.log(`  └─ Total Supply: ${formatUnits(collateralTokenInfo.totalSupply || 0n, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    
    console.log(`Oracle: ${marketParams.oracle}`);
    console.log(`Interest Rate Model: ${marketParams.irm}`);
    console.log(`Liquidation LTV: ${formatUnits(marketParams.lltv, 18)} (${(Number(formatUnits(marketParams.lltv, 18)) * 100).toFixed(2)}%)`);

    console.log("\n💰 MARKET LIQUIDITY & UTILIZATION");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`Total Supply Assets: ${formatUnits(marketState.totalSupplyAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Total Supply Shares: ${formatUnits(marketState.totalSupplyShares, loanTokenInfo.decimals)}`);
    console.log(`Total Borrow Assets: ${formatUnits(marketState.totalBorrowAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Total Borrow Shares: ${formatUnits(marketState.totalBorrowShares, loanTokenInfo.decimals)}`);
    console.log(`Available Liquidity: ${formatUnits(availableLiquidity, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Utilization Rate: ${(utilization * 100).toFixed(2)}%`);
    
    // Exchange rates
    if (marketState.totalSupplyShares > 0n) {
      const supplyExchangeRate = Number(formatUnits(marketState.totalSupplyAssets, loanTokenInfo.decimals)) / 
                                Number(formatUnits(marketState.totalSupplyShares, loanTokenInfo.decimals));
      console.log(`Supply Exchange Rate: 1 share = ${supplyExchangeRate.toFixed(6)} ${loanTokenInfo.symbol}`);
    }
    
    if (marketState.totalBorrowShares > 0n) {
      const borrowExchangeRate = Number(formatUnits(marketState.totalBorrowAssets, loanTokenInfo.decimals)) / 
                                Number(formatUnits(marketState.totalBorrowShares, loanTokenInfo.decimals));
      console.log(`Borrow Exchange Rate: 1 share = ${borrowExchangeRate.toFixed(6)} ${loanTokenInfo.symbol}`);
    }

    console.log("\n📊 ORACLE PRICING");
    console.log("───────────────────────────────────────────────────────────────");
    if (oraclePrice) {
      console.log(`Oracle Address: ${marketParams.oracle}`);
      console.log(`Raw Price: ${oraclePrice.rawPrice.toString()}`);
      console.log(`Price: 1 ${collateralTokenInfo.symbol} = ${oraclePrice.humanPrice.toFixed(8)} ${loanTokenInfo.symbol}`);
      console.log(`Inverse: 1 ${loanTokenInfo.symbol} = ${oraclePrice.inverse.toFixed(8)} ${collateralTokenInfo.symbol}`);
    } else {
      console.log("❌ Oracle price not available");
    }

    console.log("\n📈 INTEREST RATE MODEL");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`IRM Address: ${marketParams.irm}`);
    if (irmInfo.borrowRateAt80) {
      const borrowAPY = calculateAPY(irmInfo.borrowRateAt80 as bigint);
      console.log(`Borrow Rate (80% utilization): ${(Number(formatUnits(irmInfo.borrowRateAt80 as bigint, 18)) * 100).toFixed(4)}% per second`);
      console.log(`Estimated Borrow APY (80% util): ${borrowAPY.toFixed(2)}%`);
    }
    if (irmInfo.supplyRateAt80) {
      const supplyAPY = calculateAPY(irmInfo.supplyRateAt80 as bigint);
      console.log(`Supply Rate (80% utilization): ${(Number(formatUnits(irmInfo.supplyRateAt80 as bigint, 18)) * 100).toFixed(4)}% per second`);
      console.log(`Estimated Supply APY (80% util): ${supplyAPY.toFixed(2)}%`);
    }

    console.log("\n👤 USER POSITION ANALYSIS");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`User Address: ${userAddress}`);
    console.log(`Supply Position:`);
    console.log(`  ├─ Shares: ${formatUnits(userPosition.supplyShares, loanTokenInfo.decimals)}`);
    console.log(`  └─ Assets: ${formatUnits(userPosition.supplyAssets || 0n, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    
    console.log(`Borrow Position:`);
    console.log(`  ├─ Shares: ${formatUnits(userPosition.borrowShares, loanTokenInfo.decimals)}`);
    console.log(`  └─ Assets: ${formatUnits(userPosition.borrowAssets || 0n, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    
    console.log(`Collateral: ${formatUnits(userPosition.collateral, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    
    if (userPosition.borrowAssets! > 0n || userPosition.collateral > 0n) {
      console.log(`Health Factor: ${healthFactor === Infinity ? "∞ (Safe)" : healthFactor.toFixed(4)}`);
      if (healthFactor < 1.2 && healthFactor !== Infinity) {
        console.log("⚠️  WARNING: Low health factor - risk of liquidation!");
      }
    }

    console.log("\n🎯 MARKET EFFICIENCY METRICS");
    console.log("───────────────────────────────────────────────────────────────");
    
    // Market depth analysis
    const marketDepth = Number(formatUnits(marketState.totalSupplyAssets, loanTokenInfo.decimals));
    console.log(`Market Depth: ${marketDepth.toLocaleString()} ${loanTokenInfo.symbol}`);
    
    // Liquidity ratio
    const liquidityRatio = Number(formatUnits(availableLiquidity, loanTokenInfo.decimals)) / marketDepth * 100;
    console.log(`Liquidity Ratio: ${liquidityRatio.toFixed(2)}%`);
    
    // Market activity score (based on utilization)
    const activityScore = utilization * 100;
    let activityLevel = "Low";
    if (activityScore > 30) activityLevel = "Medium";
    if (activityScore > 70) activityLevel = "High";
    if (activityScore > 90) activityLevel = "Very High";
    console.log(`Market Activity: ${activityLevel} (${activityScore.toFixed(1)}% utilization)`);

    console.log("\n🔒 RISK ASSESSMENT");
    console.log("───────────────────────────────────────────────────────────────");
    
    // Liquidation threshold
    const liquidationThreshold = Number(formatUnits(marketParams.lltv, 18)) * 100;
    console.log(`Liquidation Threshold: ${liquidationThreshold.toFixed(2)}%`);
    
    // Risk level based on LTV
    let riskLevel = "Low";
    if (liquidationThreshold > 70) riskLevel = "Medium";
    if (liquidationThreshold > 80) riskLevel = "High";
    if (liquidationThreshold > 90) riskLevel = "Very High";
    console.log(`Risk Level: ${riskLevel} (based on LTV)`);
    
    // Oracle dependency
    console.log(`Oracle Dependency: ${oraclePrice ? "✅ Active" : "❌ Inactive"}`);

    console.log("\n💡 MARKET INSIGHTS");
    console.log("───────────────────────────────────────────────────────────────");
    
    if (utilization < 0.1) {
      console.log("📈 Low utilization - good for suppliers, rates may be low");
    } else if (utilization > 0.9) {
      console.log("⚠️  High utilization - limited liquidity for withdrawals");
    } else {
      console.log("✅ Healthy utilization - balanced supply and demand");
    }
    
    if (liquidityRatio < 10) {
      console.log("🚨 Low liquidity - withdrawals may be limited");
    }
    
    if (marketState.totalSupplyAssets === 0n) {
      console.log("🆕 New market - no activity yet");
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    
  } catch (error) {
    console.error("Error fetching market information:", error);
  }
}

getMarketInfo()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });