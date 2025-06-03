import { formatEther, parseEther } from "viem";
import hre from "hardhat";

async function main() {
  console.log("Deploying Flash Loan Contract...");
  
  // Get the deployer account
  const [deployer] = await hre.viem.getWalletClients();

  // Configuration - Update these addresses for your network
  const MORPHO_ADDRESS = process.env.MORPHO_ADDRESS || "0x0000000000000000000000000000000000000000";
  
  if (MORPHO_ADDRESS === "0x0000000000000000000000000000000000000000") {
    console.error("❌ Please set MORPHO_ADDRESS environment variable");
    process.exit(1);
  }

  // Deploy MorphoFlashLoan
  console.log("\nDeploying MorphoFlashLoanExecutor...");
  const flashLoanExecutor = await hre.viem.deployContract("MorphoFlashLoan", [
    MORPHO_ADDRESS,             // _morpho
    deployer.account.address    // initialOwner
  ]);
  
  console.log("✅ MorphoFlashLoanExecutor deployed to:", flashLoanExecutor.address);

  console.log("\nDeployment Details:");
  console.log("==================");
  console.log("Contract Address:", flashLoanExecutor.address);
  console.log("Deployer:", deployer.account.address);
  console.log("Morpho Address:", MORPHO_ADDRESS);

  // Save deployment information to file
  const deploymentInfo = {
    network: hre.network.name,
    contractAddress: flashLoanExecutor.address,
    morphoAddress: MORPHO_ADDRESS,
    owner: deployer.account.address,
    timestamp: new Date().toISOString()
  };

  // Write to deployments directory (create if doesn't exist)
  const fs = require('fs');
  const path = require('path');
  
  const deploymentsDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `flashloan-${hre.network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  
  console.log(`\n📄 Deployment info saved to: ${deploymentFile}`);

  // Environment variables for execution script
  console.log("\n🔧 Environment Variables for Execution:");
  console.log("=====================================");
  console.log(`export FLASHLOAN_CONTRACT_ADDRESS=${flashLoanExecutor.address}`);
  console.log(`export MORPHO_ADDRESS=${MORPHO_ADDRESS}`);
  console.log(`export NETWORK=${hre.network.name}`);

  console.log("\n🎉 Flash Loan Contract Successfully Deployed!");


  return {
    flashLoanExecutor: flashLoanExecutor.address,
    morpho: MORPHO_ADDRESS,
    owner: deployer.account.address
  };
}

main()
  .then((result) => {
    console.log("\nDeployment completed successfully!");
    console.log("Flash Loan Executor:", result.flashLoanExecutor);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });