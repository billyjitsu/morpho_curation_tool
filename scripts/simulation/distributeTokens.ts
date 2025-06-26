import { parseUnits, formatUnits } from "viem";
import { publicClient, createWalletByIndex } from "../config/configs";
import ERC20_ABI from "../abis/ERC20.json";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

// Read token addresses from deployment file
const deploymentPath = path.join(
  __dirname,
  "../../deployments/tokens-oracles-targetNetwork.json"
);
const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

// Configuration
const FAKE_USDC_ADDRESS = deploymentData.contracts.fakeUSDC.address;
const FAKE_WETH_ADDRESS = deploymentData.contracts.fakeWETH.address;
const NUMBER_OF_WALLETS = process.env.NUMBER_OF_WALLETS
  ? parseInt(process.env.NUMBER_OF_WALLETS)
  : 3;
const DISTRIBUTION_PERCENTAGE = 0.1; // 10% of deployer's balance

// Function to get user input
function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getTokenInfo(tokenAddress: string) {
  try {
    const [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "name",
      }),
      publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);

    return {
      name: name as string,
      symbol: symbol as string,
      decimals: decimals as number,
    };
  } catch (error) {
    console.error(`Error fetching token info for ${tokenAddress}:`, error);
    throw error;
  }
}

async function distributeTokens() {
  console.log("=".repeat(50));
  console.log("Token Distribution Script");
  console.log("=".repeat(50));

  console.log(`Token addresses loaded from deployment file:`);
  console.log(`FAKE_USDC: ${FAKE_USDC_ADDRESS}`);
  console.log(`FAKE_WETH: ${FAKE_WETH_ADDRESS}`);

  // Get deployer wallet (index 0)
  const deployerWallet = createWalletByIndex(0);
  console.log(`Deployer address: ${deployerWallet.account.address}`);

  // Get token information
  console.log("\nFetching token information...");
  const usdcInfo = await getTokenInfo(FAKE_USDC_ADDRESS);
  const wethInfo = await getTokenInfo(FAKE_WETH_ADDRESS);

  console.log(
    `USDC Token: ${usdcInfo.name} (${usdcInfo.symbol}) - Decimals: ${usdcInfo.decimals}`
  );
  console.log(
    `WETH Token: ${wethInfo.name} (${wethInfo.symbol}) - Decimals: ${wethInfo.decimals}`
  );

  // Check deployer's balance
  const [deployerUsdcBalance, deployerWethBalance] = await Promise.all([
    publicClient.readContract({
      address: FAKE_USDC_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [deployerWallet.account.address],
    }),
    publicClient.readContract({
      address: FAKE_WETH_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [deployerWallet.account.address],
    }),
  ]);

  console.log("\n======= Deployer's Current Balance =======");
  console.log(
    `${usdcInfo.symbol}: ${formatUnits(
      deployerUsdcBalance as bigint,
      usdcInfo.decimals
    )}`
  );
  console.log(
    `${wethInfo.symbol}: ${formatUnits(
      deployerWethBalance as bigint,
      wethInfo.decimals
    )}`
  );

  // Calculate distribution amounts (10% of balance divided equally)
  const totalUsdcToDistribute =
    ((deployerUsdcBalance as bigint) *
      BigInt(Math.floor(DISTRIBUTION_PERCENTAGE * 100))) /
    BigInt(100);
  const totalWethToDistribute =
    ((deployerWethBalance as bigint) *
      BigInt(Math.floor(DISTRIBUTION_PERCENTAGE * 100))) /
    BigInt(100);

  const usdcAmountPerWallet = totalUsdcToDistribute / BigInt(NUMBER_OF_WALLETS);
  const wethAmountPerWallet = totalWethToDistribute / BigInt(NUMBER_OF_WALLETS);

  console.log("\n======= Distribution Plan =======");
  console.log(
    `Distribution percentage: ${
      DISTRIBUTION_PERCENTAGE * 100
    }% of deployer's balance`
  );
  console.log(
    `Number of recipient wallets: ${NUMBER_OF_WALLETS} (indexes 1-${NUMBER_OF_WALLETS})`
  );
  console.log(
    `Total ${usdcInfo.symbol} to distribute: ${formatUnits(
      totalUsdcToDistribute,
      usdcInfo.decimals
    )}`
  );
  console.log(
    `Total ${wethInfo.symbol} to distribute: ${formatUnits(
      totalWethToDistribute,
      wethInfo.decimals
    )}`
  );
  console.log(
    `${usdcInfo.symbol} per wallet: ${formatUnits(
      usdcAmountPerWallet,
      usdcInfo.decimals
    )}`
  );
  console.log(
    `${wethInfo.symbol} per wallet: ${formatUnits(
      wethAmountPerWallet,
      wethInfo.decimals
    )}`
  );

  // Check if there's enough balance (should always be true since we're using 10% of existing balance)
  if (deployerUsdcBalance < totalUsdcToDistribute) {
    console.log(
      `❌ Insufficient ${usdcInfo.symbol} balance! This shouldn't happen with percentage-based distribution.`
    );
    return;
  }

  if (deployerWethBalance < totalWethToDistribute) {
    console.log(
      `❌ Insufficient ${wethInfo.symbol} balance! This shouldn't happen with percentage-based distribution.`
    );
    return;
  }

  // Check if amounts are meaningful (not zero due to rounding)
  if (usdcAmountPerWallet === BigInt(0)) {
    console.log(
      `❌ ${usdcInfo.symbol} amount per wallet is zero. Deployer balance might be too small for meaningful distribution.`
    );
    return;
  }

  if (wethAmountPerWallet === BigInt(0)) {
    console.log(
      `❌ ${wethInfo.symbol} amount per wallet is zero. Deployer balance might be too small for meaningful distribution.`
    );
    return;
  }

  // Show recipient wallet addresses
  console.log("\n======= Recipient Wallets =======");
  for (let i = 1; i <= NUMBER_OF_WALLETS; i++) {
    const recipientWallet = createWalletByIndex(i);
    console.log(`Wallet ${i}: ${recipientWallet.account.address}`);
  }

  // Confirm distribution
  const confirm = await question(
    `\nDo you want to proceed with the token distribution? (y/n): `
  );
  if (confirm.toLowerCase() !== "y") {
    console.log("Distribution cancelled by user.");
    return;
  }

  console.log("\n======= Starting Distribution =======");

  // Distribute tokens to each wallet
  for (let i = 1; i <= NUMBER_OF_WALLETS; i++) {
    const recipientWallet = createWalletByIndex(i);
    const recipientAddress = recipientWallet.account.address;

    console.log(`\n--- Distributing to Wallet ${i} (${recipientAddress}) ---`);

    try {
      // Transfer USDC
      console.log(
        `Transferring ${formatUnits(usdcAmountPerWallet, usdcInfo.decimals)} ${
          usdcInfo.symbol
        }...`
      );
      const usdcHash = await deployerWallet.writeContract({
        address: FAKE_USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipientAddress, usdcAmountPerWallet],
      });

      console.log(`${usdcInfo.symbol} transfer sent! Hash: ${usdcHash}`);
      await publicClient.waitForTransactionReceipt({ hash: usdcHash });
      console.log(`✅ ${usdcInfo.symbol} transfer confirmed!`);

      // Transfer WETH
      console.log(
        `Transferring ${formatUnits(wethAmountPerWallet, wethInfo.decimals)} ${
          wethInfo.symbol
        }...`
      );
      const wethHash = await deployerWallet.writeContract({
        address: FAKE_WETH_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipientAddress, wethAmountPerWallet],
      });

      console.log(`${wethInfo.symbol} transfer sent! Hash: ${wethHash}`);
      await publicClient.waitForTransactionReceipt({ hash: wethHash });
      console.log(`✅ ${wethInfo.symbol} transfer confirmed!`);

      // Check recipient's new balance
      const [newUsdcBalance, newWethBalance] = await Promise.all([
        publicClient.readContract({
          address: FAKE_USDC_ADDRESS as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [recipientAddress],
        }),
        publicClient.readContract({
          address: FAKE_WETH_ADDRESS as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [recipientAddress],
        }),
      ]);

      console.log(
        `New balances - ${usdcInfo.symbol}: ${formatUnits(
          newUsdcBalance as bigint,
          usdcInfo.decimals
        )}, ${wethInfo.symbol}: ${formatUnits(
          newWethBalance as bigint,
          wethInfo.decimals
        )}`
      );
    } catch (error) {
      console.error(`❌ Error distributing to wallet ${i}:`, error);
      continue;
    }
  }

  // Show final deployer balance
  const [finalUsdcBalance, finalWethBalance] = await Promise.all([
    publicClient.readContract({
      address: FAKE_USDC_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [deployerWallet.account.address],
    }),
    publicClient.readContract({
      address: FAKE_WETH_ADDRESS as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [deployerWallet.account.address],
    }),
  ]);

  console.log("\n======= Final Deployer Balance =======");
  console.log(
    `${usdcInfo.symbol}: ${formatUnits(
      finalUsdcBalance as bigint,
      usdcInfo.decimals
    )}`
  );
  console.log(
    `${wethInfo.symbol}: ${formatUnits(
      finalWethBalance as bigint,
      wethInfo.decimals
    )}`
  );

  console.log("\n🎉 Token distribution completed successfully!");
}

distributeTokens()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Distribution failed:", error);
    process.exit(1);
  });
