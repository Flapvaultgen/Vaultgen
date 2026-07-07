import { concat, getCreate2Address, type Address, type Hex } from "viem";

/**
 * OZ ClonesUpgradeable init code used by Flap Portal for deterministic token deployment.
 * This matches the assembly in ClonesUpgradeable.predictDeterministicAddress (v4.x):
 *   prefix:  3d602d80600a3d3981f3363d3d373d3d3d363d73 (20 bytes)
 *   impl:    <implementation address> (20 bytes)
 *   suffix:  5af43d82803e903d91602b57fd5bf3 (15 bytes)
 * Total init code: 55 bytes, with 0xff separator at byte 67 of the CREATE2 preimage.
 * NOTE: viem's built-in clone init code uses a different suffix and will NOT produce
 * the correct Flap token addresses.
 */
function cloneInitCode(implementation: Address): Hex {
  return concat([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
}

export function predictCloneAddress(
  implementation: Address,
  portal: Address,
  salt: Hex
): Address {
  return getCreate2Address({
    bytecode: cloneInitCode(implementation),
    from: portal,
    salt,
  });
}

function endsWith7777(address: Address): boolean {
  const hex = address.toLowerCase().slice(2);
  return hex.endsWith("7777");
}

export type VanitySearchProgress = {
  attempts: number;
  ratePerSec: number;
};

/**
 * Find a CREATE2 salt so the cloned tax token address ends in 0x7777 (Flap requirement).
 */
export async function findVanity7777Salt(
  implementation: Address,
  portal: Address,
  onProgress?: (p: VanitySearchProgress) => void
): Promise<Hex> {
  let salt = BigInt(Date.now()) << 64n;
  let attempts = 0;
  const started = performance.now();
  const yieldEvery = 4096;

  while (true) {
    const saltHex = `0x${salt.toString(16).padStart(64, "0")}` as Hex;
    const predicted = predictCloneAddress(implementation, portal, saltHex);
    if (endsWith7777(predicted)) {
      return saltHex;
    }
    salt += 1n;
    attempts += 1;
    if (attempts % yieldEvery === 0) {
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.({ attempts, ratePerSec: elapsed > 0 ? attempts / elapsed : 0 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}
