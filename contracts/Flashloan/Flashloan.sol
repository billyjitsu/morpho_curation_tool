// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IFlashLoanReceiver {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/**
 * @title MorphoFlashLoan
 * @dev Simple demonstration of Morpho flash loans - borrow and repay
 * @notice This contract demonstrates basic flash loan functionality without complex strategies
 */
contract MorphoFlashLoan is IFlashLoanReceiver, Ownable, ReentrancyGuard {
    
    IMorpho public immutable morpho;
    
    // Events
    event FlashLoanExecuted(
        address indexed token,
        uint256 amount,
        address indexed initiator
    );
    
    event FlashLoanReceived(
        address indexed token,
        uint256 amount,
        uint256 contractBalance
    );
    
    // Custom errors
    error UnauthorizedFlashLoan();
    error InsufficientBalance();
    error ApprovalFailed();
    
    constructor(address _morpho, address initialOwner) Ownable(initialOwner) {
        morpho = IMorpho(_morpho);
    }
    
    /**
     * @dev Simple flash loan execution - just borrow and repay
     * @param token The token to borrow
     * @param amount The amount to borrow
     */
    function executeFlashLoan(
        address token,
        uint256 amount
    ) external nonReentrant {
        // Store the initiator in the callback data
        bytes memory data = abi.encode(msg.sender, token);
        
        // Initiate the flash loan
        morpho.flashLoan(token, amount, data);
    }
    
    /**
     * @dev Callback function called by Morpho during flash loan
     * @param assets The amount of tokens borrowed
     * @param data Encoded data containing initiator and token address
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        // Verify the call is from Morpho
        if (msg.sender != address(morpho)) {
            revert UnauthorizedFlashLoan();
        }
        
        // Decode the data
        (address initiator, address token) = abi.decode(data, (address, address));
        
        // Get current token balance
        uint256 currentBalance = IERC20(token).balanceOf(address(this));
        
        emit FlashLoanReceived(token, assets, currentBalance);
        
        // At this point we have the borrowed tokens
        // This is where you would implement your strategy:
        // - Arbitrage trades
        // - Liquidations
        // - Collateral swaps
        // - etc.
        
        // For this simple example, we just check that we received the tokens
        // Since Morpho flash loans are free (0% fee), we only need to repay the exact amount borrowed
        
        // Ensure we have enough to repay (just the borrowed amount, no fees)
        if (currentBalance < assets) {
            revert InsufficientBalance();
        }
        
        // 🔥 KEY FIX: Approve Morpho to take back the borrowed tokens
        IERC20 tokenContract = IERC20(token);
        bool success = tokenContract.approve(address(morpho), assets);
        if (!success) {
            revert ApprovalFailed();
        }
        
        emit FlashLoanExecuted(token, assets, initiator);
        
        // The flash loan will automatically take back the exact borrowed amount
        // No fees with Morpho flash loans!
    }
    
    /**
     * @dev Emergency withdraw function - only owner
     */
    function emergencyWithdraw(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(to, balance);
        }
    }
    
    /**
     * @dev Withdraw ETH if any - only owner
     */
    function withdrawETH(address payable to) external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = to.call{value: balance}("");
            require(success, "ETH transfer failed");
        }
    }
    
    /**
     * @dev Allow contract to receive ETH
     */
    receive() external payable {}
}