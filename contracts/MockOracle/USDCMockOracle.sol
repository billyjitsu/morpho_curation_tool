// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 _roundId) external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

/**
 * @title MockChainlinkAggregator
 * @notice A mock Chainlink price feed for testing scenarios
 */
contract MockUSDChainlinkAggregator is AggregatorV3Interface {
    uint8 private _decimals;
    string private _description;
    uint256 private _version;
    int256 private _price;
    uint256 private _updatedAt;
    
    address private _owner;
    
    // Events
    event PriceUpdated(int256 oldPrice, int256 newPrice);
    
    /**
     * @notice Constructor sets the initial values
     * @param description_ Feed description (e.g., "ETH / USD")
     * @param decimals_ Decimal precision (typically 8 for Chainlink feeds)
     * @param initialPrice Initial price value scaled by 10^decimals
     */
    constructor(string memory description_, uint8 decimals_, int256 initialPrice) {
        _description = description_;
        _decimals = decimals_;
        _version = 1;
        _price = initialPrice;
        _updatedAt = block.timestamp;
        _owner = msg.sender;
    }
    
    /**
     * @notice Returns the decimals of the feed
     */
    function decimals() external view override returns (uint8) {
        return _decimals;
    }
    
    /**
     * @notice Returns the description of the feed
     */
    function description() external view override returns (string memory) {
        return _description;
    }
    
    /**
     * @notice Returns the version of the feed
     */
    function version() external view override returns (uint256) {
        return _version;
    }
    
    /**
     * @notice Gets data from a specific round
     * @dev For the mock, we return the same data regardless of the round
     */
    function getRoundData(uint80 _roundId) external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_roundId, _price, _updatedAt, _updatedAt, _roundId);
    }
    
    /**
     * @notice Gets the latest round data
     */
    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (1, _price, _updatedAt, _updatedAt, 1);
    }
    
    /**
     * @notice Sets a new price, only callable by owner
     * @param newPrice The new price value
     */
    function setPrice(int256 newPrice) external onlyOwner {
        int256 oldPrice = _price;
        _price = newPrice;
        _updatedAt = block.timestamp;
        emit PriceUpdated(oldPrice, newPrice);
    }
    
    /**
     * @notice Owner modifier
     */
    modifier onlyOwner() {
        require(msg.sender == _owner, "Not authorized");
        _;
    }
}
