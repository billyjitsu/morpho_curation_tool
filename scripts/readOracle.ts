import { parseAbi, formatUnits, PublicClient, type Address } from "viem";
import { publicClient } from "./config/configs";
import ERC20_ABI from './abis/ERC20.json';
import MORPHO_ABI from './abis/morpho.json';

// Morpho contract address
const MORPHO_ADDRESS = process.env.MORPHO_ADDRESS || "";
const MORPHO_ORACLE_ADDRESS = process.env.MORPHO_ORACLE_ADDRESS || "";
const MARKET_ID = process.env.MARKET_ID || "";

// Define the market parameters type
type MarketParams = [
  loanToken: Address,
  collateralToken: Address,
  oracle: Address,
  irm: Address,
  lltv: bigint
];

// Define token information type
interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

async function main() {

  // Get parameters from command line or use defaults
  const oracleAddress = MORPHO_ORACLE_ADDRESS as Address;
  const marketId = MARKET_ID || null;

  console.log("=".repeat(50));
  console.log(`Morpho Oracle Validator Tool`);
  console.log("=".repeat(50));

  console.log(`\nQuerying Oracle at: ${oracleAddress}`);

  // If a market ID is provided, get the market parameters
  let loanToken: TokenInfo | null = null;
  let collateralToken: TokenInfo | null = null;

  if (marketId) {
    try {
      console.log(`\nLooking up market with ID: ${marketId}`);

      const marketParams = (await publicClient.readContract({
        address: MORPHO_ADDRESS,
        abi: MORPHO_ABI,
        functionName: "idToMarketParams",
        args: [marketId],
      })) as MarketParams;

      console.log(`Market found!`);
      console.log(`Loan token: ${marketParams[0]}`);
      console.log(`Collateral token: ${marketParams[1]}`);
      console.log(`Oracle: ${marketParams[2]}`);

      // Verify the oracle matches the provided oracle
      if (marketParams[2].toLowerCase() !== oracleAddress.toLowerCase()) {
        console.log(
          `\n⚠️ WARNING: Oracle address from market (${marketParams[2]}) doesn't match provided oracle (${oracleAddress})`
        );
      } else {
        console.log(`\n✅ Oracle address matches the market's oracle`);
      }

      // Fetch token information
      loanToken = await fetchTokenInfo(marketParams[0], publicClient);
      collateralToken = await fetchTokenInfo(marketParams[1], publicClient);

      console.log(
        `\nLoan token: ${loanToken.name} (${loanToken.symbol}), decimals: ${loanToken.decimals}`
      );
      console.log(
        `Collateral token: ${collateralToken.name} (${collateralToken.symbol}), decimals: ${collateralToken.decimals}`
      );
    } catch (error) {
      console.error(`\n❌ Error fetching market parameters:`, error);
      console.log(`Continuing with oracle validation without market data...`);
    }
  } else {
    console.log(
      `\nNo market ID provided. Will validate oracle without token information.`
    );
  }

  try {
    // Fetch the current oracle price
    const rawPrice = await publicClient.readContract({
      address: oracleAddress,
      abi: parseAbi(["function price() external view returns (uint256)"]),
      functionName: "price",
    });

    console.log("\n=== Oracle Raw Price ===");
    console.log(`Raw price value: ${rawPrice}`);

    // Decode the price based on Morpho's Oracle specification
    // The price is scaled by 1e36
    const priceScaled = Number(formatUnits(rawPrice, 36));
    console.log(`\n=== Decoded Price ===`);
    console.log(`Price (scaled by 1e36): ${priceScaled}`);

    // Calculate human-readable price if we have token information
    if (loanToken && collateralToken) {
      // Formula from Morpho docs:
      // price corresponds to the price of 10^(collateral token decimals) assets of collateral token
      // quoted in 10^(loan token decimals) assets of loan token
      // with `36 + loan token decimals - collateral token decimals` decimals of precision

      const decimalAdjustment =
        36 + loanToken.decimals - collateralToken.decimals;
      const adjustedPrice = Number(formatUnits(rawPrice, decimalAdjustment));

      console.log(`\n=== Human-Readable Price ===`);
      console.log(
        `1 ${collateralToken.symbol} = ${adjustedPrice} ${loanToken.symbol}`
      );
      console.log(
        `1 ${loanToken.symbol} = ${1 / adjustedPrice} ${collateralToken.symbol}`
      );
    }
  } catch (error) {
    console.error("\n❌ Error reading oracle price:", error);
  }
}

/**
 * Fetch token information (symbol, name, decimals) from a contract
 */
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
      symbol,
      decimals,
      name,
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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
