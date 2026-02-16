// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Heap} from "@openzeppelin/contracts/utils/structs/Heap.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {HyperCore, CoreExecution} from "./HyperCore.sol";

contract CoreWriterSim {
    using Address for address;
    using Heap for Heap.Uint256Heap;
    using SafeCast for uint256;

    uint128 private _sequence;

    Heap.Uint256Heap private _actionQueue;

    struct Action {
        uint256 timestamp;
        bytes data;
        uint256 value;
    }

    enum Mode {
        SYNC,
        QUEUE
    }

    struct QueuedAction {
        uint64 actionId;
        address sender;
        uint24 kind;
        bytes payload;
        uint64 l1Block;
    }

    mapping(uint256 id => Action) _actions;

    uint64 private _nextActionId = 1;
    uint256 private _queueHead;
    uint256 private _queueTail;
    mapping(uint256 index => QueuedAction action) private _queuedActions;

    event RawAction(address indexed user, bytes data);
    event ActionQueued(uint64 indexed actionId, address indexed sender, uint24 indexed kind, uint64 l1Block, bytes payload);

    HyperCore constant _hyperCore = HyperCore(payable(0x9999999999999999999999999999999999999999));

    /////// testing config
    /////////////////////////
    bool public revertOnFailure;
    Mode public mode;

    function setRevertOnFailure(bool _revertOnFailure) public {
        revertOnFailure = _revertOnFailure;
    }

    function setMode(Mode newMode) public {
        mode = newMode;
    }

    function getQueueLength() public view returns (uint256) {
        return _queueTail - _queueHead;
    }

    function getQueuedActions(uint256 offset, uint256 limit) external view returns (QueuedAction[] memory actions) {
        uint256 queueLength = getQueueLength();
        if (offset >= queueLength || limit == 0) {
            return new QueuedAction[](0);
        }

        uint256 available = queueLength - offset;
        uint256 size = limit < available ? limit : available;
        actions = new QueuedAction[](size);

        for (uint256 i = 0; i < size; i++) {
            actions[i] = _queuedActions[_queueHead + offset + i];
        }
    }

    function consumeQueuedActions(uint256 count) external {
        uint256 queueLength = getQueueLength();
        require(count <= queueLength, "Consume exceeds queue length");

        for (uint256 i = 0; i < count; i++) {
            delete _queuedActions[_queueHead + i];
        }

        _queueHead += count;
        if (_queueHead == _queueTail) {
            _queueHead = 0;
            _queueTail = 0;
        }
    }

    function enqueueAction(bytes memory data, uint256 value) public {
        enqueueAction(block.timestamp, data, value);
    }

    function enqueueAction(uint256 timestamp, bytes memory data, uint256 value) public {
        uint256 uniqueId = (uint256(timestamp) << 128) | uint256(_sequence++);

        _actions[uniqueId] = Action(timestamp, data, value);
        _actionQueue.insert(uniqueId);
    }

    function executeQueuedActions(bool expectRevert) external {
        bool atLeastOneFail;
        while (_actionQueue.length() > 0) {
            Action memory action = _actions[_actionQueue.peek()];

            // the action queue is a priority queue so the timestamp takes precedence in the
            // ordering which means we can safely stop processing if the actions are delayed
            if (action.timestamp > block.timestamp) {
                break;
            }

            (bool success,) = address(_hyperCore).call{value: action.value}(action.data);

            if (!success) {
                atLeastOneFail = true;
            }

            if (revertOnFailure && !success && !expectRevert) {
                revert("CoreWriter action failed: Reverting due to revertOnFailure flag");
            }

            _actionQueue.pop();
        }

        if (expectRevert && !atLeastOneFail) {
            revert("Expected revert, but action succeeded");
        }

        _hyperCore.processStakingWithdrawals();
    }

    function tokenTransferCallback(uint64 token, address from, uint256 value) public {
        // there's a special case when transferring to the L1 via the system address which
        // is that the balance isn't reflected on the L1 until after the EVM block has finished
        // and the subsequent EVM block has been processed, this means that the balance can be
        // in limbo for the user
        tokenTransferCallback(msg.sender, token, from, value);
    }

    function tokenTransferCallback(address sender, uint64 token, address from, uint256 value) public {
        enqueueAction(abi.encodeCall(CoreExecution.executeTokenTransfer, (sender, token, from, value)), 0);
    }

    function nativeTransferCallback(address sender, address from, uint256 value) public payable {
        enqueueAction(abi.encodeCall(CoreExecution.executeNativeTransfer, (sender, from, value)), value);
    }

    function sendRawAction(bytes calldata data) external {
        uint8 version = uint8(data[0]);
        require(version == 1);

        uint24 kind = (uint24(uint8(data[1])) << 16) | (uint24(uint8(data[2])) << 8) | (uint24(uint8(data[3])));

        bytes memory payload = data[4:];

        if (mode == Mode.QUEUE) {
            if (_nextActionId == 0) {
                _nextActionId = 1;
            }

            uint64 actionId = _nextActionId++;
            uint64 l1Block = block.number.toUint64();

            _queuedActions[_queueTail] = QueuedAction({
                actionId: actionId,
                sender: msg.sender,
                kind: kind,
                payload: payload,
                l1Block: l1Block
            });
            _queueTail++;

            emit ActionQueued(actionId, msg.sender, kind, l1Block, payload);
            emit RawAction(msg.sender, data);
            return;
        }

        bytes memory call = abi.encodeCall(HyperCore.executeRawAction, (msg.sender, kind, payload));

        enqueueAction(block.timestamp, call, 0);

        emit RawAction(msg.sender, data);
    }
}
