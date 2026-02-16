// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HyperCore} from "./HyperCore.sol";
import {HLConstants} from "../../src/common/HLConstants.sol";
import {PrecompileLib} from "../../src/PrecompileLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CoreDepositWalletSim {
    using SafeERC20 for IERC20;

    HyperCore constant _hyperCore = HyperCore(payable(0x9999999999999999999999999999999999999999));

    uint256 private constant USDC_EVM_TO_CORE_SCALE = 100;
    uint64 private constant ACTIVATION_FEE_CORE = 1e8;

    error AmountTooLarge();
    error ZeroRecipient();
    error InsufficientAmountForActivation();

    event DepositSimulated(address indexed caller, address indexed recipient, uint64 coreAmount, uint32 destinationDex);

    function deposit(uint256 amount, uint32 destinationDex) external {
        _credit(msg.sender, msg.sender, amount, destinationDex);
    }

    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external {
        _credit(msg.sender, recipient, amount, destinationDex);
    }

    function _credit(address caller, address recipient, uint256 amount, uint32 destinationDex) internal {
        if (recipient == address(0)) {
            revert ZeroRecipient();
        }

        _pullUsdcIfAvailable(caller, amount);

        uint256 converted = amount * USDC_EVM_TO_CORE_SCALE;
        if (converted > type(uint64).max) {
            revert AmountTooLarge();
        }

        uint64 coreAmount = uint64(converted);
        uint64 creditedAmount = coreAmount;

        if (!PrecompileLib.coreUserExists(recipient)) {
            if (coreAmount < ACTIVATION_FEE_CORE) {
                revert InsufficientAmountForActivation();
            }
            creditedAmount = coreAmount - ACTIVATION_FEE_CORE;
        }

        uint64 tokenIndex = HLConstants.USDC_TOKEN_INDEX;

        PrecompileLib.SpotBalance memory current = _hyperCore.readSpotBalance(recipient, tokenIndex);
        uint256 nextTotal = uint256(current.total) + creditedAmount;
        if (nextTotal > type(uint64).max) {
            revert AmountTooLarge();
        }

        _hyperCore.forceSpotBalance(recipient, tokenIndex, uint64(nextTotal));

        emit DepositSimulated(caller, recipient, creditedAmount, destinationDex);
    }

    function _pullUsdcIfAvailable(address caller, uint256 amount) internal {
        address usdc = HLConstants.usdc();
        if (usdc.code.length == 0) {
            return;
        }

        IERC20(usdc).safeTransferFrom(caller, address(this), amount);
    }
}
