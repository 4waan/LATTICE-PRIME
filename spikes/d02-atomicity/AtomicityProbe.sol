// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0 <0.9.0;

/**
 * @notice a design decision: does an EVM revert roll back an HTS token transfer made in the
 *         same transaction.
 * @dev The repo design settles a security (an EVM diamond) against cash (an HTS
 *      token). "Atomic DvP" is only a claim we may make if the two systems share
 *      a rollback boundary. This contract is the smallest thing that can answer
 *      that: the same transfer, once committed and once followed by a revert.
 *
 *      HTS fungible tokens expose an ERC-20 facade at their own EVM address
 *      (HIP-218), so no HTS interface file is needed. Association is done
 *      through the HRC-719 method on the token address itself.
 */
interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IHRC719 {
    function associate() external returns (uint256 responseCode);
}

contract AtomicityProbe {
    error Bail();

    /// @dev The contract must hold the token before it can send it, and holding
    ///      requires association. Self-association, so no admin key is needed.
    function associateWith(address token) external returns (uint256) {
        return IHRC719(token).associate();
    }

    /// @dev The control. If this does not move the balance, the revert arm below
    ///      proves nothing, because "no movement" would be the outcome either way.
    function moveThenSucceed(address token, address to, uint256 amount) external {
        IERC20Like(token).transfer(to, amount);
    }

    /// @dev The measurement. Same call, then an unconditional revert.
    function moveThenRevert(address token, address to, uint256 amount) external {
        IERC20Like(token).transfer(to, amount);
        revert Bail();
    }

    /// @dev The sharper case. The HTS transfer succeeds, the EVM revert happens
    ///      in a callee whose failure the caller swallows. If HTS ignores EVM
    ///      frame boundaries, the balance moves while the caller reports nothing
    ///      went wrong, which is worse than a plain non-atomic transfer.
    function moveThenRevertCaught(address token, address to, uint256 amount) external returns (bool caught) {
        try this.moveThenRevert(token, to, amount) {
            return false;
        } catch {
            return true;
        }
    }

    /// @dev The composite, and the one the repo design actually rests on. Cash
    ///      moves on HTS, then the security leg is attempted on the ATS diamond
    ///      and fails. DvP requires that the cash movement does not survive it.
    ///      The security call is expected to revert on its own terms: this
    ///      contract holds no bond units and is not KYC granted.
    function cashThenSecurity(
        address token,
        address to,
        uint256 amount,
        address security,
        uint256 units
    ) external {
        IERC20Like(token).transfer(to, amount);
        IERC20Like(security).transfer(to, units);
    }

    function balance(address token, address who) external view returns (uint256) {
        return IERC20Like(token).balanceOf(who);
    }
}
