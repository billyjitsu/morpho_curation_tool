import { formatEther, parseEther } from "viem";
import hre from "hardhat";

async function main() {
  console.log("Deploying contracts...");
  
  // Get the deployer account
  const [deployer] = await hre.viem.getWalletClients();
  console.log("Deploying from account:", deployer.account.address);

  // Deploy FakeUSDC
  console.log("\nDeploying FakeUSDC...");
  const fakeUSDC = await hre.viem.deployContract("FakeUSDC", [
    deployer.account.address, // recipient
    deployer.account.address  // initialOwner
  ]);
  console.log("✅ FakeUSDC deployed to:", fakeUSDC.address);

  // Deploy FakeWETH
  console.log("\nDeploying FakeWETH...");
  const fakeWETH = await hre.viem.deployContract("FakeWETH", [
    deployer.account.address, // recipient
    deployer.account.address  // initialOwner
  ]);
  console.log("✅ FakeWETH deployed to:", fakeWETH.address);

  // Deploy ETH Price Oracle
  console.log("\nDeploying ETH Price Oracle...");
  const ethOracle = await hre.viem.deployContract("MockWETHhainlinkAggregator", [
    "ETH / USD",     // description
    8n,              // decimals (8 is standard for Chainlink)
    200000000000n    // initial price ($2000.00000000)
  ]);
  console.log("✅ ETH Oracle deployed to:", ethOracle.address);

  // Deploy USDC Price Oracle
  console.log("\nDeploying USDC Price Oracle...");
  const usdcOracle = await hre.viem.deployContract("MockUSDChainlinkAggregator", [
    "USDC / USD",    // description
    8n,              // decimals
    100000000n       // initial price ($1.00000000)
  ]);
  console.log("✅ USDC Oracle deployed to:", usdcOracle.address);

  // Save deployment information to file
  const deploymentInfo = {
    network: hre.network.name,
    contracts: {
      fakeUSDC: {
        address: fakeUSDC.address,
        name: "FakeUSDC",
        type: "ERC20Token"
      },
      fakeWETH: {
        address: fakeWETH.address,
        name: "FakeWETH", 
        type: "ERC20Token"
      },
      ethOracle: {
        address: ethOracle.address,
        name: "MockWETHhainlinkAggregator",
        type: "PriceOracle",
        description: "ETH / USD",
        decimals: 8,
        initialPrice: "2000.00000000"
      },
      usdcOracle: {
        address: usdcOracle.address,
        name: "MockUSDChainlinkAggregator", 
        type: "PriceOracle",
        description: "USDC / USD",
        decimals: 8,
        initialPrice: "1.00000000"
      }
    },
    deployer: deployer.account.address,
    timestamp: new Date().toISOString()
  };

  // Write to deployments directory (create if doesn't exist)
  const fs = require('fs');
  const path = require('path');
  
  const deploymentsDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `tokens-oracles-${hre.network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  
  console.log(`\n📄 Deployment info saved to: ${deploymentFile}`);

  // Verify contract addresses
  console.log("\nDeployment Summary:");
  console.log("===================");
  console.log("FakeUSDC:", fakeUSDC.address);
  console.log("FakeWETH:", fakeWETH.address);
  console.log("ETH Oracle:", ethOracle.address);
  console.log("USDC Oracle:", usdcOracle.address);
  console.log("Deployer:", deployer.account.address);

  // Environment variables for easy access
  console.log("\n🔧 Environment Variables:");
  console.log("========================");
  console.log(`export FAKE_USDC_ADDRESS=${fakeUSDC.address}`);
  console.log(`export FAKE_WETH_ADDRESS=${fakeWETH.address}`);
  console.log(`export ETH_ORACLE_ADDRESS=${ethOracle.address}`);
  console.log(`export USDC_ORACLE_ADDRESS=${usdcOracle.address}`);
  console.log(`export NETWORK=${hre.network.name}`);

  console.log("\n🎉 Token and Oracle Contracts Successfully Deployed!");

  return {
    fakeUSDC: fakeUSDC.address,
    fakeWETH: fakeWETH.address,
    ethOracle: ethOracle.address,
    usdcOracle: usdcOracle.address,
    deployer: deployer.account.address
  };
}

main()
  .then((result) => {
    console.log("\nDeployment completed successfully!");
    console.log("FakeUSDC:", result.fakeUSDC);
    console.log("FakeWETH:", result.fakeWETH);
    console.log("ETH Oracle:", result.ethOracle);
    console.log("USDC Oracle:", result.usdcOracle);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });