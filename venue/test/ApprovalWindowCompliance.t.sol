// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ApprovalWindowCompliance} from "../src/policy/ApprovalWindowCompliance.sol";

contract ApprovalWindowComplianceTest is Test {
    address internal constant TOKEN = address(0x100);
    address internal constant OWNER = address(0x200);
    address internal constant SPENDER = address(0x300);

    ApprovalWindowCompliance internal window;

    function setUp() public {
        window = new ApprovalWindowCompliance(TOKEN, OWNER, SPENDER);
    }

    function test_onlyTheZeroValueApprovalTuplePasses() public view {
        assertTrue(window.canTransfer(OWNER, SPENDER, 0));
        assertFalse(window.canTransfer(OWNER, SPENDER, 1));
        assertFalse(window.canTransfer(address(0x201), SPENDER, 0));
        assertFalse(window.canTransfer(OWNER, address(0x301), 0));
    }

    function test_onlyTheTokenMayReachCallbacks() public {
        vm.prank(TOKEN);
        window.transferred(OWNER, SPENDER, 0);

        vm.expectRevert(ApprovalWindowCompliance.NotToken.selector);
        window.created(OWNER, 0);
    }
}
