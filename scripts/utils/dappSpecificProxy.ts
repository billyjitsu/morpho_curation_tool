import * as api3Contracts from "@api3/contracts";
import * as api3DapiManagement from "@api3/dapi-management";
import { stringToHex, keccak256, encodePacked, Address, Hex } from "viem";
import { publicClient, walletClient, target_Network } from "../config/configs";
import API3_READER_PROXY_V1_FACTORY_ABI from "../abis/IApi3ReaderProxy.json";

interface Dapi {
  name: string;
  stage: string;
}

interface DApp {
  alias: string;
}

const dapiName = process.env.DAPI_NAME || "";
const dappAlias = process.env.DAPP_ALIAS || "";
const chainId = target_Network.id || "";

// Utility function to validate dAPI name
function validateDapiName(dapiName: string): void {
  const dapi = (api3DapiManagement as any).dapis.find(
    (dapi: Dapi) => dapi.name === dapiName
  );
  if (!dapi) {
    throw new Error(`dAPI with name ${dapiName} does not exist`);
  }
  if (dapi.stage === "deprecated") {
    console.warn(`dAPI with name ${dapiName} is deprecated`);
  } else if (dapi.stage !== "active") {
    throw new Error(
      `dAPI with name ${dapiName} is not active, its current state is ${dapi.stage}`
    );
  }
}

function computeDappIdUnsafe(dappAlias: string, chainId: number): bigint {
  const dappAliasHash = keccak256(encodePacked(["string"], [dappAlias]));
  return BigInt(
    keccak256(
      encodePacked(["bytes32", "uint256"], [dappAliasHash, BigInt(chainId)])
    )
  );
}

async function main(): Promise<void> {
  validateDapiName(dapiName);

  // Check if dApp alias is recognized (with proper typing)
  if (
    !(api3Contracts as any).DAPPS.some((dapp: DApp) => dapp.alias === dappAlias)
  ) {
    console.warn(
      `@api3/contracts does not include the dApp with alias ${dappAlias}. Deployment will continue anyway.`
    );
  }

  const dappId = computeDappIdUnsafe(dappAlias, chainId);
  console.log(`Computed dApp ID: ${dappId}`);

  // Get the expected proxy address
  const api3ReaderProxyV1Address = (
    api3Contracts as any
  ).computeApi3ReaderProxyV1Address(chainId, dapiName, dappId, "0x") as Address;
  console.log(
    `Expected Api3ReaderProxyV1 address: ${api3ReaderProxyV1Address}`
  );

  // Check if contract already exists
  const existingCode = await publicClient.getCode({
    address: api3ReaderProxyV1Address,
  });

  if (!existingCode || existingCode === "0x") {
    const api3ReaderProxyV1FactoryAddress = (api3Contracts as any)
      .deploymentAddresses.Api3ReaderProxyV1Factory[
      chainId.toString()
    ] as Address;
    console.log(
      `Api3ReaderProxyV1Factory address: ${api3ReaderProxyV1FactoryAddress}`
    );

    if (!api3ReaderProxyV1FactoryAddress) {
      throw new Error(
        `Api3ReaderProxyV1Factory not deployed on chain ${chainId}`
      );
    }

    console.log(
      `Deploying Api3ReaderProxyV1 for ${dappAlias} and ${dapiName}...`
    );

    const hash = await walletClient.writeContract({
      address: api3ReaderProxyV1FactoryAddress,
      abi: API3_READER_PROXY_V1_FACTORY_ABI,
      functionName: "deployApi3ReaderProxyV1",
      args: [stringToHex(dapiName, { size: 32 }), dappId, "0x" as Hex],
    });

    console.log(`Transaction hash: ${hash}`);

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log(
      `${dappAlias}'s Api3ReaderProxyV1 for ${dapiName} is deployed at ${api3ReaderProxyV1Address} on chain ${chainId}`
    );
  } else {
    console.log(
      `${dappAlias}'s Api3ReaderProxyV1 for ${dapiName} was already deployed at ${api3ReaderProxyV1Address} on chain ${chainId}`
    );
  }
}

// Execute main function
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
