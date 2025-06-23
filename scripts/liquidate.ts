import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, createWalletByIndex, account } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);

let morphoAddress = process.env.MORPHO_ADDRESS || "";
let marketId = process.env.MARKET_ID || "";
let borrowerAddress = process.env.BORROWER_ADDRESS || walletClient.account.address; // Default to the wallet address if not provided
let seizedAssets = process.env.SEIZED_ASSETS || "0"; // Amount of collateral to seize
let repaidShares = process.env.REPAID_SHARES || "0"; // Amount of debt shares to repay
let maxLiquidation = process.env.MAX_LIQUIDATION === "true" || false; // Liquidate maximum possible
let validateLiquidation = process.env.VALIDATE_LIQUIDATION === "true" || true; // Safety check

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

interface UserPosition {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  borrowAssets?: bigint;
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

// Fetch token information
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

// Get oracle price
async function getOraclePrice(
  oracleAddress: Address,
  loanToken: TokenInfo,
  collateralToken: TokenInfo,
  publicClient: PublicClient
): Promise<bigint> {
  try {
    const rawPrice = await publicClient.readContract({
      address: oracleAddress,
      abi: parseAbi(["function price() external view returns (uint256)"]),
      functionName: "price",
    }) as bigint;

    return rawPrice;
  } catch (error) {
    console.error("Error fetching oracle price:", error);
    throw new Error("Could not fetch oracle price - liquidation cannot proceed safely");
  }
}

// Calculate user's actual debt from shares
function calculateBorrowAssets(
  borrowShares: bigint,
  totalBorrowShares: bigint,
  totalBorrowAssets: bigint
): bigint {
  if (totalBorrowShares === 0n) return 0n;
  return (borrowShares * totalBorrowAssets) / totalBorrowShares;
}

// Check if position is liquidatable
function isLiquidatable(
  collateralValue: bigint,
  borrowValue: bigint,
  lltv: bigint
): boolean {
  if (borrowValue === 0n) return false;
  
  const maxBorrowValue = (collateralValue * lltv) / parseUnits("1", 18);
  return borrowValue > maxBorrowValue;
}

// Calculate health factor
function calculateHealthFactor(
  collateralValue: bigint,
  borrowValue: bigint,
  lltv: bigint
): number {
  if (borrowValue === 0n) return Infinity;
  
  const maxBorrowValue = (collateralValue * lltv) / parseUnits("1", 18);
  return Number(formatUnits(maxBorrowValue, 18)) / Number(formatUnits(borrowValue, 18));
}

// Calculate maximum liquidation amounts
function calculateMaxLiquidation(
  collateral: bigint,
  borrowAssets: bigint,
  oraclePrice: bigint,
  loanTokenDecimals: number,
  collateralTokenDecimals: number,
  lltv: bigint
): { maxSeizedAssets: bigint; maxRepaidAssets: bigint; liquidationIncentive: number } {
  
  // Standard liquidation incentive is usually around 5-10%
  const liquidationIncentive = 1.05; // 5% bonus for liquidator
  
  // Calculate collateral value in loan token terms
  const decimalAdjustment = 36 + loanTokenDecimals - collateralTokenDecimals;
  const collateralValueInLoanToken = (collateral * oraclePrice) / parseUnits("1", decimalAdjustment);
  
  // Maximum that can be repaid is typically 50% of debt or what's needed to restore health
  const maxRepaidAssets = borrowAssets / 2n; // 50% max liquidation
  
  // Calculate corresponding collateral that can be seized
  const repaidValueWithIncentive = (maxRepaidAssets * BigInt(Math.floor(liquidationIncentive * 1000))) / 1000n;
  const maxSeizedAssets = (repaidValueWithIncentive * parseUnits("1", decimalAdjustment)) / oraclePrice;
  
  // Ensure we don't seize more collateral than available
  const actualMaxSeized = maxSeizedAssets > collateral ? collateral : maxSeizedAssets;
  
  return {
    maxSeizedAssets: actualMaxSeized,
    maxRepaidAssets: maxRepaidAssets,
    liquidationIncentive: liquidationIncentive
  };
}

async function liquidatePosition() {
  // Validate required parameters
  if (!morphoAddress) {
    throw new Error("Morpho address is required. Set it with MORPHO_ADDRESS environment variable.");
  }
  if (!marketId) {
    throw new Error("Market ID is required. Set it with MARKET_ID environment variable.");
  }
  if (!borrowerAddress) {
    throw new Error("Borrower address is required. Set it with BORROWER_ADDRESS environment variable.");
  }

  try {
    console.log("🔍 Analyzing liquidation opportunity...\n");
    
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

    // Get market state for share calculations
    const marketResult = await publicClient.readContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "market",
      args: [marketId as `0x${string}`]
    });
    
    let totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares;
    if (Array.isArray(marketResult)) {
      [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = marketResult;
    } else {
      ({ totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares } = marketResult as any);
    }

    // Get borrower's position
    let borrowerPosition: UserPosition;
    try {
      const result = await publicClient.readContract({
        address: morphoAddress as `0x${string}`,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [marketId as `0x${string}`, borrowerAddress as `0x${string}`]
      });
      
      if (Array.isArray(result)) {
        const [supplyShares, borrowShares, collateral] = result;
        borrowerPosition = { supplyShares, borrowShares, collateral };
      } else {
        borrowerPosition = result as UserPosition;
      }
      
      // Calculate actual debt
      borrowerPosition.borrowAssets = calculateBorrowAssets(
        borrowerPosition.borrowShares,
        totalBorrowShares,
        totalBorrowAssets
      );
    } catch (error) {
      throw new Error("Could not fetch borrower position");
    }

    // Check if borrower has a position
    if (borrowerPosition.borrowShares === 0n || borrowerPosition.collateral === 0n) {
      console.log("❌ Borrower has no liquidatable position (no debt or collateral)");
      return;
    }

    // Get token information
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

    // Calculate collateral value in loan token terms
    const decimalAdjustment = 36 + loanTokenInfo.decimals - collateralTokenInfo.decimals;
    const collateralValueInLoanToken = (borrowerPosition.collateral * oraclePrice) / parseUnits("1", decimalAdjustment);
    
    // Calculate health factor
    const healthFactor = calculateHealthFactor(
      collateralValueInLoanToken,
      borrowerPosition.borrowAssets!,
      marketParams.lltv
    );

    // Check if position is liquidatable
    const liquidatable = isLiquidatable(
      collateralValueInLoanToken,
      borrowerPosition.borrowAssets!,
      marketParams.lltv
    );

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("💀 LIQUIDATION ANALYSIS");
    console.log("═══════════════════════════════════════════════════════════════");
    
    console.log(`\n📊 BORROWER POSITION:`);
    console.log(`Address: ${borrowerAddress}`);
    console.log(`Collateral: ${formatUnits(borrowerPosition.collateral, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    console.log(`Debt: ${formatUnits(borrowerPosition.borrowAssets!, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Collateral Value: ${formatUnits(collateralValueInLoanToken, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Health Factor: ${healthFactor === Infinity ? "∞" : healthFactor.toFixed(4)}`);
    console.log(`LLTV Threshold: ${(Number(formatUnits(marketParams.lltv, 18)) * 100).toFixed(2)}%`);
    console.log(`Liquidatable: ${liquidatable ? "✅ YES" : "❌ NO"}`);

    if (!liquidatable) {
      console.log("\n🛡️ Position is healthy - liquidation not possible");
      console.log(`Health factor must be < 1.0 for liquidation (current: ${healthFactor.toFixed(4)})`);
      return;
    }

    // Calculate maximum liquidation amounts
    const maxLiquidationData = calculateMaxLiquidation(
      borrowerPosition.collateral,
      borrowerPosition.borrowAssets!,
      oraclePrice,
      loanTokenInfo.decimals,
      collateralTokenInfo.decimals,
      marketParams.lltv
    );

    console.log(`\n⚡ LIQUIDATION OPPORTUNITY:`);
    console.log(`Max Collateral Seizable: ${formatUnits(maxLiquidationData.maxSeizedAssets, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    console.log(`Max Debt Repayable: ${formatUnits(maxLiquidationData.maxRepaidAssets, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Liquidation Incentive: ${((maxLiquidationData.liquidationIncentive - 1) * 100).toFixed(1)}%`);

    // Determine liquidation amounts
    let seizedAssetsBigInt: bigint;
    let repaidAssetsBigInt: bigint;

    if (maxLiquidation) {
      seizedAssetsBigInt = maxLiquidationData.maxSeizedAssets;
      repaidAssetsBigInt = maxLiquidationData.maxRepaidAssets;
      seizedAssets = formatUnits(seizedAssetsBigInt, collateralTokenInfo.decimals);
      console.log(`\n🎯 Using maximum liquidation amounts`);
    } else {
      if (seizedAssets === "0" && repaidShares === "0") {
        console.log(`\n💡 No specific amounts provided. Use MAX_LIQUIDATION=true or set SEIZED_ASSETS/REPAID_SHARES`);
        const useMax = await question("Use maximum liquidation amounts? (y/n): ");
        if (useMax.toLowerCase() === "y") {
          seizedAssetsBigInt = maxLiquidationData.maxSeizedAssets;
          repaidAssetsBigInt = maxLiquidationData.maxRepaidAssets;
          seizedAssets = formatUnits(seizedAssetsBigInt, collateralTokenInfo.decimals);
        } else {
          console.log("Liquidation cancelled - no amounts specified");
          return;
        }
      } else {
        if (seizedAssets !== "0") {
          seizedAssetsBigInt = parseUnits(seizedAssets, collateralTokenInfo.decimals);
        } else {
          seizedAssetsBigInt = maxLiquidationData.maxSeizedAssets;
        }
        
        if (repaidShares !== "0") {
          // Convert shares to assets
          const repaidSharesBigInt = parseUnits(repaidShares, loanTokenInfo.decimals);
          repaidAssetsBigInt = calculateBorrowAssets(repaidSharesBigInt, totalBorrowShares, totalBorrowAssets);
        } else {
          repaidAssetsBigInt = maxLiquidationData.maxRepaidAssets;
        }
      }
    }

    // Validate liquidation amounts
    if (seizedAssetsBigInt > maxLiquidationData.maxSeizedAssets) {
      console.log(`⚠️ Seized amount exceeds maximum. Adjusting to max: ${formatUnits(maxLiquidationData.maxSeizedAssets, collateralTokenInfo.decimals)}`);
      seizedAssetsBigInt = maxLiquidationData.maxSeizedAssets;
    }

    if (repaidAssetsBigInt > maxLiquidationData.maxRepaidAssets) {
      console.log(`⚠️ Repaid amount exceeds maximum. Adjusting to max: ${formatUnits(maxLiquidationData.maxRepaidAssets, loanTokenInfo.decimals)}`);
      repaidAssetsBigInt = maxLiquidationData.maxRepaidAssets;
    }

    // Check liquidator's balance
    const liquidatorBalance = await publicClient.readContract({
      address: marketParams.loanToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    }) as bigint;

    if (liquidatorBalance < repaidAssetsBigInt) {
      console.log(`❌ Insufficient balance for liquidation`);
      console.log(`Required: ${formatUnits(repaidAssetsBigInt, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
      console.log(`Available: ${formatUnits(liquidatorBalance, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
      return;
    }

    // Calculate profit estimation
    const collateralValueSeized = (seizedAssetsBigInt * oraclePrice) / parseUnits("1", decimalAdjustment);
    const profit = collateralValueSeized - repaidAssetsBigInt;
    const profitPercentage = Number(formatUnits(profit, loanTokenInfo.decimals)) / Number(formatUnits(repaidAssetsBigInt, loanTokenInfo.decimals)) * 100;

    console.log(`\n💰 LIQUIDATION EXECUTION PLAN:`);
    console.log(`Collateral to Seize: ${formatUnits(seizedAssetsBigInt, collateralTokenInfo.decimals)} ${collateralTokenInfo.symbol}`);
    console.log(`Debt to Repay: ${formatUnits(repaidAssetsBigInt, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);
    console.log(`Estimated Profit: ${formatUnits(profit, loanTokenInfo.decimals)} ${loanTokenInfo.symbol} (${profitPercentage.toFixed(2)}%)`);
    console.log(`Your Balance: ${formatUnits(liquidatorBalance, loanTokenInfo.decimals)} ${loanTokenInfo.symbol}`);

    if (validateLiquidation) {
      const confirm = await question("\n⚠️ Are you sure you want to execute this liquidation? (y/n): ");
      if (confirm.toLowerCase() !== 'y') {
        console.log("Liquidation cancelled by user");
        return;
      }
    }

    // Check and set approval
    const allowance = await publicClient.readContract({
      address: marketParams.loanToken,
      abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
      functionName: "allowance",
      args: [walletClient.account.address, morphoAddress]
    }) as bigint;

    if (allowance < repaidAssetsBigInt) {
      console.log(`Setting approval for liquidation...`);
      const approveHash = await walletClient.writeContract({
        address: marketParams.loanToken,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [morphoAddress as `0x${string}`, repaidAssetsBigInt]
      });
      
      console.log("Approval transaction sent! Waiting for confirmation...");
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approval successful!");
    }

    // Convert repaid assets back to shares for the liquidation call
    const repaidSharesForCall = (repaidAssetsBigInt * totalBorrowShares) / totalBorrowAssets;

    // Prepare market params tuple
    const marketParamsTuple = {
      loanToken: marketParams.loanToken,
      collateralToken: marketParams.collateralToken,
      oracle: marketParams.oracle,
      irm: marketParams.irm,
      lltv: marketParams.lltv
    };

    // Execute liquidation
    console.log(`\n⚡ Executing liquidation...`);
    const liquidationHash = await walletClient.writeContract({
      address: morphoAddress as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "liquidate",
      args: [
        marketParamsTuple,
        borrowerAddress as `0x${string}`,
        seizedAssetsBigInt,
        repaidSharesForCall,
        "0x" // data (empty bytes)
      ]
    });

    console.log("Liquidation transaction sent! Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: liquidationHash });

    console.log("✅ Liquidation successful!");
    console.log("Transaction hash:", receipt.transactionHash);

    // Get updated balances
    const newLiquidatorLoanBalance = await publicClient.readContract({
      address: marketParams.loanToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    }) as bigint;

    const newLiquidatorCollateralBalance = await publicClient.readContract({
      address: marketParams.collateralToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletClient.account.address]
    }) as bigint;

    console.log(`\n🎉 LIQUIDATION RESULTS:`);
    console.log(`New ${loanTokenInfo.symbol} Balance: ${formatUnits(newLiquidatorLoanBalance, loanTokenInfo.decimals)}`);
    console.log(`New ${collateralTokenInfo.symbol} Balance: ${formatUnits(newLiquidatorCollateralBalance, collateralTokenInfo.decimals)}`);
    console.log(`Profit Realized: Check the difference in your token balances`);

  } catch (error) {
    console.error("Error executing liquidation:", error);
  }
}

liquidatePosition()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });