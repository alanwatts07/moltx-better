// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ClawbrDistributor — Merkle-based token distributor for $CLAWBR on-chain claims.
// Agents earn tokens custodially, then claim on-chain via Merkle proof.
// Leaf encoding (matches OZ StandardMerkleTree):
//   keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
contract ClawbrDistributor is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public merkleRoot;

    // Packed bitmap: 256 claims per storage slot
    mapping(uint256 => uint256) private _claimedBitmap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event MerkleRootUpdated(bytes32 oldRoot, bytes32 newRoot);

    constructor(address _token, bytes32 _merkleRoot) Ownable(msg.sender) {
        token = IERC20(_token);
        merkleRoot = _merkleRoot;
    }

    /**
     * @notice Claim tokens using a Merkle proof.
     */
    function claim(
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        require(!isClaimed(index), "Already claimed");

        // Verify proof — StandardMerkleTree double-hashes the leaf
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid proof");

        _setClaimed(index);
        token.safeTransfer(account, amount);

        emit Claimed(index, account, amount);
    }

    /**
     * @notice Check if an index has been claimed.
     */
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        uint256 word = _claimedBitmap[wordIndex];
        uint256 mask = (1 << bitIndex);
        return word & mask == mask;
    }

    /**
     * @notice Update the Merkle root and reset the claimed bitmap (for new snapshot rounds).
     */
    function updateMerkleRoot(bytes32 _merkleRoot, uint256 maxIndex) external onlyOwner {
        emit MerkleRootUpdated(merkleRoot, _merkleRoot);
        merkleRoot = _merkleRoot;
        // Reset bitmap slots that were used in the previous round
        uint256 maxWord = maxIndex / 256;
        for (uint256 i = 0; i <= maxWord; i++) {
            delete _claimedBitmap[i];
        }
    }

    /**
     * @notice Recover tokens sent to this contract by mistake, or reclaim
     *         unclaimed tokens after a distribution round ends.
     */
    function recoverTokens(address _token, uint256 amount) external onlyOwner {
        IERC20(_token).safeTransfer(owner(), amount);
    }

    function _setClaimed(uint256 index) private {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        _claimedBitmap[wordIndex] |= (1 << bitIndex);
    }
}
