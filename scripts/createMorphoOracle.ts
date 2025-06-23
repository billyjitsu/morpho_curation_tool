import { parseUnits, formatUnits, parseAbi, PublicClient, type Address } from "viem";
import { publicClient, createWalletByIndex } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import ORACLE_FACTORY_ABI from './abis/oracle_factory.json';
import ORACLE_AGGREGATOR_ABI from './abis/oracle_aggregator.json';
import * as readline from 'readline';

const walletClient = createWalletByIndex(0);

let factoryAddress = process.env.ORACLE_FACTORY_ADDRESS || "";
let loanTokenAddress = process.env.LOANTOKEN_ADDRESS || "";
let collateralTokenAddress = process.env.COLLATERALTOKEN_ADDRESS || "";
let baseFeed1 = process.env.COLLATERAL_ORACLE_ADDRESS_F1 || "";
let baseFeed2 = process.env.COLLATERAL_ORACLE_ADDRESS_F2 || "0x0000000000000000000000000000000000000000";
let quoteFeed1 = process.env.LOAN_ORACLE_ADDRESS_F1 || "";
let quoteFeed2 = process.env.LOAN_ORACLE_ADDRESS_F2 || "0x0000000000000000000000000000000000000000";
let baseVault = process.env.BASE_VAULT || "0x0000000000000000000000000000000000000000";
let quoteVault = process.env.QUOTE_VAULT || "0x0000000000000000000000000000000000000000";
let baseVaultConversionSample = process.env.BASE_VAULT_CONVERSION_SAMPLE || "1";
let quoteVaultConversionSample = process.env.QUOTE_VAULT_CONVERSION_SAMPLE || "1";
let salt = process.env.SALT || "0x0000000000000000000000000000000000000000000000000000000000000004";
let skipVerification = false;

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

// Define token information type
interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

interface OracleInfo {
  description: string;
  decimals: number;
  latestPrice: bigint;
  updatedAt: Date;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Retry function to get oracle address from logs
async function getOracleAddressFromLogs(blockNumber: bigint, retries = MAX_RETRIES): Promise<Address | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempting to get oracle address from logs (attempt ${attempt}/${retries})...`);
      
      const logs = await publicClient.getLogs({
        address: factoryAddress as `0x${string}`,
        event: {
          type: 'event',
          name: 'CreateMorphoChainlinkOracleV2',
          inputs: [
            { name: 'caller', type: 'address', indexed: false },
            { name: 'oracle', type: 'address', indexed: false }
          ]
        },
        fromBlock: blockNumber,
        toBlock: blockNumber
      });
      
      if (logs.length > 0 && logs[0].args && logs[0].args.oracle) {
        return logs[0].args.oracle as Address;
      }
      
      if (attempt < retries) {
        console.log(`No logs found, waiting ${RETRY_DELAY/1000} seconds before retry...`);
        await sleep(RETRY_DELAY);
      }
    } catch (error) {
      console.log(`Error getting logs on attempt ${attempt}:`, error);
      if (attempt < retries) {
        console.log(`Waiting ${RETRY_DELAY/1000} seconds before retry...`);
        await sleep(RETRY_DELAY);
      }
    }
  }
  
  return null;
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
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "name",
      }),
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

// Fetch oracle information
async function fetchOracleInfo(
  oracleAddress: Address,
  publicClient: PublicClient
): Promise<OracleInfo | null> {
  try {
    // Try to get oracle info
    const [decimals, description, latestRoundData] = await Promise.all([
      publicClient.readContract({
        address: oracleAddress,
        abi: ORACLE_AGGREGATOR_ABI,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: oracleAddress,
        abi: ORACLE_AGGREGATOR_ABI,
        functionName: "description",
      }),
      publicClient.readContract({
        address: oracleAddress,
        abi: ORACLE_AGGREGATOR_ABI,
        functionName: "latestRoundData",
      }),
    ]);
    
    const [, answer, , updatedAt] = latestRoundData as [bigint, bigint, bigint, bigint, bigint];
    
    return {
      description: description as string,
      decimals: decimals as number,
      latestPrice: answer as bigint,
      updatedAt: new Date(Number(updatedAt) * 1000),
    };
  } catch (error) {
    console.error(`Error fetching info for oracle ${oracleAddress}:`, error);
    return null;
  }
}

// Format price with decimals
function formatPrice(price: bigint, decimals: number): string {
  return formatUnits(price, decimals);
}

// Validate oracle configuration
async function validateOracleConfig(
  loanTokenInfo: TokenInfo,
  collateralTokenInfo: TokenInfo,
  baseFeed1Info: OracleInfo | null,
  baseFeed2Info: OracleInfo | null,
  quoteFeed1Info: OracleInfo | null,
  quoteFeed2Info: OracleInfo | null,
  baseVault: Address,
  quoteVault: Address
): Promise<boolean> {
  console.log("\n======= Oracle Configuration Validation =======");
  
  let isValid = true;
  
  // Validate token decimals
  console.log(`Loan Token (${loanTokenInfo.symbol}): ${loanTokenInfo.decimals} decimals`);
  console.log(`Collateral Token (${collateralTokenInfo.symbol}): ${collateralTokenInfo.decimals} decimals`);
  
  // Validate oracle feeds
  if (baseFeed1Info) {
    console.log(`\nCollateral Oracle Feed 1: ${baseFeed1Info.description}`);
    console.log(`- Decimals: ${baseFeed1Info.decimals}`);
    console.log(`- Latest Price: ${formatPrice(baseFeed1Info.latestPrice, baseFeed1Info.decimals)}`);
    console.log(`- Last Updated: ${baseFeed1Info.updatedAt.toLocaleString()}`);
    
    // Check if feed is too old (1 day)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    if (baseFeed1Info.updatedAt < oneDayAgo) {
      console.log("⚠️ WARNING: Collateral Oracle Feed 1 data is more than 1 day old!");
      isValid = false;
    }
  } else if (baseFeed1 !== "0x0000000000000000000000000000000000000000") {
    console.log("❌ ERROR: Could not validate Collateral Oracle Feed 1");
    isValid = false;
  }
  
  if (baseFeed2Info && baseFeed2 !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nCollateral Oracle Feed 2: ${baseFeed2Info.description}`);
    console.log(`- Decimals: ${baseFeed2Info.decimals}`);
    console.log(`- Latest Price: ${formatPrice(baseFeed2Info.latestPrice, baseFeed2Info.decimals)}`);
    console.log(`- Last Updated: ${baseFeed2Info.updatedAt.toLocaleString()}`);
    
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    if (baseFeed2Info.updatedAt < oneDayAgo) {
      console.log("⚠️ WARNING: Collateral Oracle Feed 2 data is more than 1 day old!");
      isValid = false;
    }
  }
  
  if (quoteFeed1Info) {
    console.log(`\nLoan Oracle Feed 1: ${quoteFeed1Info.description}`);
    console.log(`- Decimals: ${quoteFeed1Info.decimals}`);
    console.log(`- Latest Price: ${formatPrice(quoteFeed1Info.latestPrice, quoteFeed1Info.decimals)}`);
    console.log(`- Last Updated: ${quoteFeed1Info.updatedAt.toLocaleString()}`);
    
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    if (quoteFeed1Info.updatedAt < oneDayAgo) {
      console.log("⚠️ WARNING: Loan Oracle Feed 1 data is more than 1 day old!");
      isValid = false;
    }
  } else if (quoteFeed1 !== "0x0000000000000000000000000000000000000000") {
    console.log("❌ ERROR: Could not validate Loan Oracle Feed 1");
    isValid = false;
  }
  
  if (quoteFeed2Info && quoteFeed2 !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nLoan Oracle Feed 2: ${quoteFeed2Info.description}`);
    console.log(`- Decimals: ${quoteFeed2Info.decimals}`);
    console.log(`- Latest Price: ${formatPrice(quoteFeed2Info.latestPrice, quoteFeed2Info.decimals)}`);
    console.log(`- Last Updated: ${quoteFeed2Info.updatedAt.toLocaleString()}`);
    
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    if (quoteFeed2Info.updatedAt < oneDayAgo) {
      console.log("⚠️ WARNING: Loan Oracle Feed 2 data is more than 1 day old!");
      isValid = false;
    }
  }
  
  // Validate vault addresses if provided
  if (baseVault !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nBase Vault: ${baseVault}`);
    console.log(`Base Vault Conversion Sample: ${baseVaultConversionSample}`);
    // Note: Additional validation for ERC4626 vault needed here
  }
  
  if (quoteVault !== "0x0000000000000000000000000000000000000000") {
    console.log(`\nQuote Vault: ${quoteVault}`);
    console.log(`Quote Vault Conversion Sample: ${quoteVaultConversionSample}`);
    // Note: Additional validation for ERC4626 vault needed here
  }
  
  console.log("\n==============================================");
  
  return isValid;
}

// Calculate expected oracle price in human-readable form
function calculateExpectedPrice(
  loanTokenInfo: TokenInfo,
  collateralTokenInfo: TokenInfo,
  baseFeed1Info: OracleInfo | null,
  baseFeed2Info: OracleInfo | null,
  quoteFeed1Info: OracleInfo | null,
  quoteFeed2Info: OracleInfo | null
): string {
  
  let basePrice = 1.0;
  let quotePrice = 1.0;
  
  // Calculate base (collateral) price
  if (baseFeed1Info) {
    basePrice *= Number(formatPrice(baseFeed1Info.latestPrice, baseFeed1Info.decimals));
  }
  
  if (baseFeed2Info) {
    basePrice *= Number(formatPrice(baseFeed2Info.latestPrice, baseFeed2Info.decimals));
  }
  
  // Calculate quote (loan) price
  if (quoteFeed1Info) {
    quotePrice *= Number(formatPrice(quoteFeed1Info.latestPrice, quoteFeed1Info.decimals));
  }
  
  if (quoteFeed2Info) {
    quotePrice *= Number(formatPrice(quoteFeed2Info.latestPrice, quoteFeed2Info.decimals));
  }
  
  // Oracle price = basePrice / quotePrice
  const expectedPrice = basePrice / quotePrice;
  
  // Format based on token decimals
  // This is a rough estimation - the actual oracle will have more precise calculations
  return expectedPrice.toFixed(8);
}

async function deployOracle() {
  // Validate required parameters
  if (!factoryAddress) {
    throw new Error("Oracle factory address is required. Set it with --factory=0x... or in ORACLE_FACTORY_ADDRESS environment variable.");
  }
  if (!loanTokenAddress) {
    throw new Error("Loan token address is required. Set it with --loanToken=0x... or in LOANTOKEN_ADDRESS environment variable.");
  }
  if (!collateralTokenAddress) {
    throw new Error("Collateral token address is required. Set it with --collateralToken=0x... or in COLLATERALTOKEN_ADDRESS environment variable.");
  }
  if (!baseFeed1 && !baseFeed2) {
    throw new Error("At least one collateral feed is required. Set it with --baseFeed1=0x... or in COLLATERAL_ORACLE_ADDRESS_F1 environment variable.");
  }
  if (!quoteFeed1 && !quoteFeed2) {
    throw new Error("At least one loan feed is required. Set it with --quoteFeed1=0x... or in LOAN_ORACLE_ADDRESS_F1 environment variable.");
  }

  try {
    console.log("=".repeat(50));
    console.log("Morpho Oracle Deployment Tool");
    console.log("=".repeat(50));
    
    // Fetch token information
    console.log("\nFetching token information...");
    const loanTokenInfo = await fetchTokenInfo(loanTokenAddress as Address, publicClient);
    const collateralTokenInfo = await fetchTokenInfo(collateralTokenAddress as Address, publicClient);
    
    console.log(`Loan Token: ${loanTokenInfo.name} (${loanTokenInfo.symbol}), decimals: ${loanTokenInfo.decimals}`);
    console.log(`Collateral Token: ${collateralTokenInfo.name} (${collateralTokenInfo.symbol}), decimals: ${collateralTokenInfo.decimals}`);
    
    // Fetch oracle feed information
    console.log("\nFetching oracle feed information...");
    let baseFeed1Info = null;
    let baseFeed2Info = null;
    let quoteFeed1Info = null;
    let quoteFeed2Info = null;
    
    if (baseFeed1 !== "0x0000000000000000000000000000000000000000") {
      baseFeed1Info = await fetchOracleInfo(baseFeed1 as Address, publicClient);
    }
    
    if (baseFeed2 !== "0x0000000000000000000000000000000000000000") {
      baseFeed2Info = await fetchOracleInfo(baseFeed2 as Address, publicClient);
    }
    
    if (quoteFeed1 !== "0x0000000000000000000000000000000000000000") {
      quoteFeed1Info = await fetchOracleInfo(quoteFeed1 as Address, publicClient);
    }
    
    if (quoteFeed2 !== "0x0000000000000000000000000000000000000000") {
      quoteFeed2Info = await fetchOracleInfo(quoteFeed2 as Address, publicClient);
    }
    
    // Validate oracle configuration
    const isValid = await validateOracleConfig(
      loanTokenInfo,
      collateralTokenInfo,
      baseFeed1Info,
      baseFeed2Info,
      quoteFeed1Info,
      quoteFeed2Info,
      baseVault as Address,
      quoteVault as Address
    );
    
    if (!isValid && !skipVerification) {
      console.log("\n❌ Oracle configuration validation failed.");
      const forceDeploy = await question("Do you want to proceed with deployment anyway? (y/n): ");
      if (forceDeploy.toLowerCase() !== "y") {
        console.log("Deployment cancelled.");
        return;
      }
    }
    
    // Calculate expected price
    const expectedPrice = calculateExpectedPrice(
      loanTokenInfo,
      collateralTokenInfo,
      baseFeed1Info,
      baseFeed2Info,
      quoteFeed1Info,
      quoteFeed2Info
    );
    
    console.log(`\nEstimated Oracle Price: 1 ${collateralTokenInfo.symbol} ≈ ${expectedPrice} ${loanTokenInfo.symbol}`);
    console.log(`Estimated Oracle Price: 1 ${loanTokenInfo.symbol} ≈ ${(1/Number(expectedPrice)).toFixed(8)} ${collateralTokenInfo.symbol}`);
    
    // Display deployment parameters
    console.log("\n======= Oracle Deployment Parameters =======");
    console.log(`Factory Address: ${factoryAddress}`);
    console.log(`Base (Collateral) Token: ${collateralTokenInfo.symbol} (${collateralTokenAddress})`);
    console.log(`Quote (Loan) Token: ${loanTokenInfo.symbol} (${loanTokenAddress})`);
    console.log(`Base Feed 1: ${baseFeed1}`);
    console.log(`Base Feed 2: ${baseFeed2}`);
    console.log(`Quote Feed 1: ${quoteFeed1}`);
    console.log(`Quote Feed 2: ${quoteFeed2}`);
    console.log(`Base Vault: ${baseVault}`);
    console.log(`Base Vault Conversion Sample: ${baseVaultConversionSample}`);
    console.log(`Quote Vault: ${quoteVault}`);
    console.log(`Quote Vault Conversion Sample: ${quoteVaultConversionSample}`);
    console.log(`Salt: ${salt}`);
    console.log("==============================================");
    
    // Confirm deployment
    const confirm = await question("\nDo you want to deploy this oracle configuration? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      console.log("Deployment cancelled by user.");
      return;
    }
    
    // Prepare deployment parameters
    const baseVaultConversionSampleBigInt = parseUnits(baseVaultConversionSample, 0);
    const quoteVaultConversionSampleBigInt = parseUnits(quoteVaultConversionSample, 0);
    
    console.log("\nDeploying oracle...");
    const deployTx = await walletClient.writeContract({
      address: factoryAddress as `0x${string}`,
      abi: ORACLE_FACTORY_ABI,
      functionName: "createMorphoChainlinkOracleV2",
      args: [
        baseVault as `0x${string}`,
        baseVaultConversionSampleBigInt,
        baseFeed1 as `0x${string}`,
        baseFeed2 as `0x${string}`,
        BigInt(collateralTokenInfo.decimals),
        quoteVault as `0x${string}`,
        quoteVaultConversionSampleBigInt,
        quoteFeed1 as `0x${string}`,
        quoteFeed2 as `0x${string}`,
        BigInt(loanTokenInfo.decimals),
        salt as `0x${string}`
      ]
    });
    
    console.log("Deployment transaction sent! Waiting for confirmation...");
    console.log(`Transaction hash: ${deployTx}`);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
    
    // Try to find the oracle address from the event logs with retry logic
    console.log("Checking transaction logs for the new oracle address...");
    const oracleAddress = await getOracleAddressFromLogs(receipt.blockNumber);
    
    if (!oracleAddress) {
      console.log("✅ Oracle deployed successfully, but couldn't automatically determine the address after multiple attempts.");
      console.log("Check the transaction on the block explorer to find the deployed oracle address.");
      return;
    }
    
    console.log(`\n✅ Oracle deployed successfully at address: ${oracleAddress}`);
    
    // Verify that the oracle is recognized by the factory
    const isRecognized = await publicClient.readContract({
      address: factoryAddress as `0x${string}`,
      abi: ORACLE_FACTORY_ABI,
      functionName: "isMorphoChainlinkOracleV2",
      args: [oracleAddress]
    });
    
    if (isRecognized) {
      console.log("✅ Oracle is recognized by the factory as a valid MorphoChainlinkOracleV2");
    } else {
      console.log("⚠️ Warning: Oracle is NOT recognized by the factory. This could indicate a deployment issue.");
    }
    
    // Test the oracle
    try {
      const oraclePrice = await publicClient.readContract({
        address: oracleAddress,
        abi: parseAbi(["function price() view returns (uint256)"]),
        functionName: "price"
      }) as bigint;
      
      console.log("\n======= Oracle Test Results =======");
      console.log(`Raw Oracle Price: ${oraclePrice}`);
      
      // Calculate human-readable price
      // Oracle price in Morpho is scaled by 10^36
      const scaledPrice = Number(formatUnits(oraclePrice, 36));
      
      console.log(`\nDeployed Oracle Price: 1 ${collateralTokenInfo.symbol} = ${scaledPrice} ${loanTokenInfo.symbol}`);
      if (scaledPrice !== 0) {
        console.log(`Deployed Oracle Price: 1 ${loanTokenInfo.symbol} = ${(1/scaledPrice).toFixed(8)} ${collateralTokenInfo.symbol}`);
      }
      
      console.log("===================================");
      
    } catch (error) {
      console.error("❌ Error testing oracle. The oracle may not be functioning correctly:", error);
    }
    
    console.log("\n🎉 Oracle deployment complete!");
    console.log("Oracle Address:", oracleAddress);
    console.log(`\nSave this address for creating your MORPHO_ORACLE_ADDRESS: ${oracleAddress}`);
    
  } catch (error) {
    console.error("Error deploying oracle:", error);
  }
}

deployOracle()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });