import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export type MerkleEntry = {
  index: number;
  wallet: string;
  amountOnChain: string; // uint256 string
};

/**
 * Build a StandardMerkleTree from claim entries.
 * Leaf encoding: [uint256 index, address account, uint256 amount]
 * This matches the Solidity contract's leaf hash:
 *   keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
 */
export function buildMerkleTree(entries: MerkleEntry[]) {
  const leaves = entries.map((e) => [
    BigInt(e.index),
    e.wallet,
    BigInt(e.amountOnChain),
  ]);

  const tree = StandardMerkleTree.of(leaves, ["uint256", "address", "uint256"]);

  // Extract proofs for each entry by index
  const proofs = new Map<number, string[]>();
  for (const [i, leaf] of tree.entries()) {
    const entryIndex = Number(leaf[0]);
    proofs.set(entryIndex, tree.getProof(i));
  }

  return {
    root: tree.root,
    proofs,
    tree,
  };
}
