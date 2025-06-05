## Morpho Curation Execution Tool
This project contains scripts for interacting with the Morpho Protocol, including vault creation, market setup, and various operations to setup.

[Code Flow Video Companion](https://www.youtube.com/watch?v=pQyvEe44Y8U)

[OEV Oracle Setup Video](https://www.youtube.com/watch?v=BXgohiuHXww)

![diagram](https://i.imgur.com/zZWdW46.png)

You can find the deployed Morpho addresses [here](https://docs.morpho.org/overview/resources/addresses/)

Once you download the repo, make sure to install all the packages
```
yarn install
```

Make sure to make a copy of the .env.example and lable it .env as this will be used for the rest of the repo examples.

To support all networks that may not be supported by viem by default, in the `scripts/config/config.ts` file.  You can manually add your network

Follow the scripts in the order below:


`For testing purposes, we have the option to deploy your own tokens to setup markets and vaults on a testnet. If you are doing this on mainnet, skip Step 0`

### Step 0: Deploy Mock Tokens and Mock Oracles
Deploy your ERC-20 tokens that will be used as assets in the protocol.

Contracts:
- FUSDC.sol - Mock USDC token
- FWETH.sol - Mock WETH token
- ETHMockOracle.sol - Mock ETH price oracle
- USDCMockOracle.sol - Mock USDC price oracle


```
yarn deploy
```

### Step 1: Create Vault

Creates a new Morpho vault based on the `VAULT_TOKEN_ADDRESS` that will be used to create liquidity for the Markets get assigned to.

```
yarn createVault
```
What it does:

Deploys a new Morpho vault contract
Sets initial vault parameters
Returns vault address for subsequent operations

### Step 2a (Optional But Recommended): Generate your OEV rewards oracle
This script will generate your specified oracle feeds.  These price feeds will have OEV enabled, so if liquidations occur, the Market will generate income if the liquidator uses OEV to liquidate the unhealthy position.  
In the `.env file`, set a value for the price feed of choice. Ex:  ETH/USD in DAPI_NAME and the name of your Market in DAPP_ALIAS
Ex: 

- DAPI_NAME="ETH/USD"
- DAPP_ALIAS="Billy ETH USDC Market"

```
yarn dappSpecificProxy
 ```

### Step 2: Create Morpho Oracle
Creates the oracle adaptor for you choice of oracle for both the Collateral Token and the Loan Token for your Market.
While most oracles are compatible with this, I recommend using [Api3](https://market.api3.org/) oracles as they have OEV built into the oracle system for additional revenue options for the Market.

For Markets using a ERC4626, you must set a BASE_VAULT value in your .env.  If you are using a standard token ERC20 (eg. ETH/USD), you will leave at 0x0 as default.

*note - The salt allows different predetermined addresses and allows multiple oracle adaptors that have the same assets deployed by different curators.

```
let factoryAddress = process.env.ORACLE_FACTORY_ADDRESS || "";
let loanTokenAddress = process.env.LOANTOKEN_ADDRESS || "";
let collateralTokenAddress = process.env.COLLATERALTOKEN_ADDRESS || "";
let baseVault = process.env.BASE_VAULT || "0x0000000000000000000000000000000000000000";
let baseFeed1 = process.env.COLLATERAL_ORACLE_ADDRESS_F1 || "";
let baseFeed2 = process.env.COLLATERAL_ORACLE_ADDRESS_F2 || "0x0000000000000000000000000000000000000000";
let quoteFeed1 = process.env.LOAN_ORACLE_ADDRESS_F1 || "";
let quoteFeed2 = process.env.LOAN_ORACLE_ADDRESS_F2 || "0x0000000000000000000000000000000000000000";
let quoteVault = process.env.QUOTE_VAULT || "0x0000000000000000000000000000000000000000";
let baseVaultConversionSample = process.env.BASE_VAULT_CONVERSION_SAMPLE || "1";
let quoteVaultConversionSample = process.env.QUOTE_VAULT_CONVERSION_SAMPLE || "1";
let salt = process.env.SALT || "0x0000000000000000000000000000000000000000000000000000000000000000";
```

```
yarn createMorphoOracle
```

What it does:

Deploys oracle contracts for asset price feeds
Configures price sources and validation parameters
Essential for market risk assessment

### Step 3: Create a Market
Creates lending/borrowing market for specific asset pairs.  After deploying your Oracle adaptor, you will update the `MORPHO_ORACLE_ADDRESS` in the .env file.  You must also set your Liquidation Loan to Value amount.  As a curator, your analysis of a safe LTV ratio determines the confidence of your market.  Set, your value in the `LLTV` in the .env


```
yarn createMarket
```

What it does:

Creates new lending markets with specified collateral and loan tokens
Sets market parameters (LTV, liquidation thresholds, etc.)
Links markets to appropriate oracles


### Step 4: Configure your Vault
Sets up vault governance and operational parameters.
This script sets, the addresses for each role for the vault.  Such as what markets it will associate itself to, supply caps, etc.
You can read more about each role [here](https://github.com/morpho-org/metamorpho?tab=readme-ov-file#roles)

Set your addresses in the .env file and if you would like to override the default FEE_AMOUNT, add it with a value to your .env file 
```
const CURATOR_ADDRESS =  process.env.CURATOR_ADDRESS || "";
const ALLOCATOR_ADDRESS = process.env.ALLOCATOR_ADDRESS || "";
const GUARDIAN_ADDRESS = process.env.GUARDIAN_ADDRESS || "";
const FEE_RECIPIENT_ADDRESS = process.env.FEE_RECIPIENT_ADDRESS || "";
const SKIM_RECIPIENT_ADDRESS = process.env.SKIM_RECIPIENT_ADDRESS || "";
const FEE_AMOUNT = process.env.FEE_AMOUNT || 10000000000000000n;
```


```
yarn configureVault
```

What it does:

- Sets the Curator (manages market additions)
- Sets the Allocator (manages capital allocation)
- Sets the Guardian (emergency controls)
- Sets Fee recipient (receives protocol fees)
- Sets Skim recipient (receives excess tokens)

### Step 5: Add a Market to Vault
This adds a market to your vault while also proposing the supply cap.  Meaning how much of the vault's liquidity would be allowed to enter this market.  This is based on the risk analysis of the curator.

By default, the supply cap is set to 1,000,000.  To override this, set a `SUPPLY_CAP` variable in your .env and set a value to it


```
yarn addMarket
```


What it does:

Proposes adding a specific market to the vault
Sets initial supply cap proposals
Requires curator approval in next step

### Step 6: Approve the Market and Cap to Vault
The script will check for any pending approvals for the vault. The Curator approves and finalizes the supply caps for markets.

```
yarn addMarketCap
```

What it does:

Curator accepts/approves the proposed supply caps
Finalizes market addition to vault
Enables the market for deposits


### Step 7: Set Market Supply Queue to Vault
Configures the order in which markets receive deposits. Because a vault can be connected to multiple markets (to maximize different vault risk/rewards), we as the Curator must see the order of which markets the liquidity of our vaults fill first and in what order.

```
yarn setMarketSupply
```

What it does:

Sets the priority order for depositing funds into markets
Determines capital allocation strategy
Higher priority markets receive funds first


### Step 8: Update Withdraw Queue to Vault
Configures the order in which markets are withdrawn from.


```
yarn updateMarketWithdraw
```

What it does:

Sets the priority order for withdrawing funds from markets
Ensures liquidity management during withdrawals
Higher priority markets are withdrawn from first


### Step 9: Deposit to Vaults
Deposit assets into the vault to earn yield. 

Now that we have our Vault and Single Market Setup, we can now deposit our assets into the Vault to earn yield.  The Vault will supply the Market with liquidity to be available to be lent out in the Market.

By default/demo, the deposit is set to 10 tokens, to override this set a Value to DEPOSIT_AMOUNT in your .env file

```
yarn depositToVault
```


What it does:

Deposits user assets into the vault
Receives vault shares representing ownership
Assets are automatically allocated based on supply queue


### Step 10: Deposit Collateral to Market
Supply collateral directly to a specific market for borrowing.  We want to test our Market to make sure it is working correctly, so we will deposit our Collateral token to then we can test our borrow capabilities.

By default, it will deposit 10,000 tokens to the market as collateral.  To override this, set COLLATERAL_AMOUNT with a value in your .env file

```
yarn supplyCollateralToMarket
```

What it does:

Supplies collateral tokens to a specific market
Enables borrowing against the collateral
Increases user's borrowing capacity


### Step 11: Borrow Token from Market
Borrow assets against supplied collateral. By default, the script will borrow 0.5 of the Loan token.  To override this, set BORROW_AMOUNT with the amount you want to borrow in the .env file.

```
yarn borrowFromMarket
```

What it does:

Borrows assets from a market using supplied collateral
Must maintain healthy collateralization ratio
Accrues interest over time


### Step 12: Repay Debt
Repay borrowed amounts to reduce debt position.  By default, it will repay 0.005 of the debt token, to override this set REPAY_AMOUNT and provide the value you want to repay in the .env file

```
yarn repayDebt
```

What it does:

Repays borrowed assets plus accrued interest
Reduces debt position
Frees up collateral for withdrawal


### Step 13: Withdraw from Vaults
Withdraw assets from the vault.

```
yarn withdrawFromVault
```

What it does:

Burns vault shares to withdraw underlying assets
Assets are withdrawn based on withdraw queue priority
May be subject to withdrawal fees or delays

## Additional Tools
#### Read Oracle
After deploying the oracle adaptor, you can read the rate and oracle values directly from the adaptor to verify all is working correctly.

```
yarn readOracle
```


#### Vault Info:
Displays current vault information and status

```
yarn vault
```

### Market Info:
Displays the current market information and status

```
yarn market
```

### Supply Loan tokens to the Market Directly
Bypasses the vault deposit and earns yield directly on the specific market

```
yarn supplyLoanTokensToMarket
```

### Withdraw Loan tokens from Market
Withdraws the tokens supplied to the market for lending

```
yarn withdrawLoanTokensFromMarket
```

### Test out the Flashloans from Morpho
This requires you to deploy your own smart contract

```
yarn deployFlashloan
```
Once you have update the .env file with your deployed contract

```
yarn flashloan
```

### Liquidate
Call the function to liquidate a specific wallet
Health factor must be below 1.0

```
yarn liquidate
```

