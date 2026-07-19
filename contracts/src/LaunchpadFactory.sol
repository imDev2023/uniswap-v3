// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {BondingCurve} from "./BondingCurve.sol";

/// @notice Entry point for creating a token launch.
/// @dev Build 02 (#13): deploys a fixed-supply immutable LaunchToken and collects the
///      creation fee. The full 1B supply is minted to this factory as custodian — no
///      pre-mine to the creator (fair launch, decision #5). Later tickets (#14) route
///      the 800M curve allocation to a bonding curve and reserve 200M for graduation.
///      Fee/treasury are owner-adjustable and apply only to FUTURE launches (decision #9);
///      ownership is transferred to a multisig in Build 07 (#18).
contract LaunchpadFactory is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Split of the fixed 1B supply: 80% sold on the curve, 20% reserved to seed
    ///         the graduation pool (decisions #5/#6). The reserve is held by this factory.
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant GRADUATION_RESERVE = 200_000_000e18;

    /// @notice Default virtual reserves for new curves. Calibrated precisely to the ETH
    ///         graduation threshold in Build 05 (#16); working defaults for now.
    uint256 public constant DEFAULT_VIRTUAL_ETH_RESERVE = 30 ether;
    uint256 public constant DEFAULT_VIRTUAL_TOKEN_RESERVE = 1_073_000_000e18;

    /// @notice Default curve trade fee, 1% (decision #5). Passed to each curve at creation.
    uint16 public constant DEFAULT_TRADE_FEE_BPS = 100;

    /// @notice Anti-snipe defaults (decision #7): per-wallet cap = 1% of the 800M curve
    ///         allocation, in force until 15% of the curve has sold, then auto-lifts.
    uint256 public constant DEFAULT_MAX_BUY_PER_WALLET = 8_000_000e18; // 1% of 800M
    uint256 public constant DEFAULT_ANTI_SNIPE_THRESHOLD = 120_000_000e18; // 15% of 800M

    /// @notice Address that receives creation fees (and, later, protocol fees).
    address public treasury;

    /// @notice Flat fee to create a launch (default 0.01 ETH, decision #5).
    uint256 public creationFee;

    /// @notice Every token this factory has launched, in creation order.
    address[] public launches;

    /// @notice token => creator who launched it.
    mapping(address => address) public creatorOf;

    /// @notice token => its bonding curve.
    mapping(address => address) public curveOf;

    event LaunchCreated(
        address indexed token, address indexed curve, address indexed creator, string name, string symbol
    );
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    error InsufficientCreationFee(uint256 sent, uint256 required);
    error ZeroTreasury();
    error FeeTransferFailed();
    error RefundFailed();

    constructor(address initialOwner, address treasury_, uint256 creationFee_) Ownable(initialOwner) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = treasury_;
        creationFee = creationFee_;
    }

    /// @notice Number of launches created so far.
    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice Create a new token launch. The caller pays at least `creationFee`; any
    ///         excess is refunded. The full fixed supply is minted to this factory.
    /// @return token The newly deployed LaunchToken.
    function createLaunch(string calldata name, string calldata symbol)
        external
        payable
        returns (address token)
    {
        uint256 fee = creationFee;
        if (msg.value < fee) revert InsufficientCreationFee(msg.value, fee);

        token = address(new LaunchToken(name, symbol, address(this)));
        address curve = address(
            new BondingCurve(
                IERC20(token),
                treasury,
                DEFAULT_VIRTUAL_ETH_RESERVE,
                DEFAULT_VIRTUAL_TOKEN_RESERVE,
                CURVE_SUPPLY,
                DEFAULT_TRADE_FEE_BPS,
                DEFAULT_MAX_BUY_PER_WALLET,
                DEFAULT_ANTI_SNIPE_THRESHOLD
            )
        );
        // 80% goes to the curve for sale; the 20% graduation reserve stays in this factory (#16).
        IERC20(token).safeTransfer(curve, CURVE_SUPPLY);

        launches.push(token);
        creatorOf[token] = msg.sender;
        curveOf[token] = curve;
        emit LaunchCreated(token, curve, msg.sender, name, symbol);

        // Interactions last.
        if (fee > 0) {
            (bool ok,) = treasury.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Update the creation fee (applies to future launches only).
    function setCreationFee(uint256 newFee) external onlyOwner {
        emit CreationFeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    /// @notice Update the treasury address (applies to future fees only).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
