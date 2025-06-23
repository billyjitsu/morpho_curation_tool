import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  networks: {
    targetNetwork: {
      url: process.env.TARGET_NETWORK_RPC_URL!,
      accounts: {
        mnemonic: process.env.MNEMONIC!,
      },
      // accounts: [process.env.PRIVATE_KEY!],
    },
  },
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: {
      cornMaizenet: 'corn', // apiKey is not required, just set a placeholder
    },
    customChains: [
      {
        network: 'cornMaizenet',
        chainId: 21000000,
        urls: {
          apiURL: 'https://api.routescan.io/v2/network/mainnet/evm/21000000/etherscan',
          browserURL: 'https://cornscan.io'
        }
      }
    ]
  },
  sourcify: {
    enabled: true
  }
};

export default config;
