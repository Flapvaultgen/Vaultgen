import { isAddress, type Hex } from "viem";
import {
  DEFAULT_LAUNCH_NETWORK,
  flapPublicClient,
  getFlapNetwork,
  type FlapLaunchNetworkId,
} from "./flap-networks";

/** Matches testnet.flap.sh `vaultDataSchema()` ABI (module 4054 / I2). */
export const CODEGEN_FACTORY_ABI = [
  {
    name: "vaultDataSchema",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "schema",
        type: "tuple",
        components: [
          { name: "description", type: "string" },
          {
            name: "fields",
            type: "tuple[]",
            components: [
              { name: "name", type: "string" },
              { name: "fieldType", type: "string" },
              { name: "description", type: "string" },
              { name: "decimals", type: "uint8" },
            ],
          },
          { name: "isArray", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "factorySpecVersion",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "isQuoteTokenSupported",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "quoteToken", type: "address" }],
    outputs: [{ name: "supported", type: "bool" }],
  },
] as const;

/** @deprecated Prefer flapPublicClient(chainId). */
export const flapTestnetPublicClient = flapPublicClient(DEFAULT_LAUNCH_NETWORK.chainId);

export type FactoryProbeResult =
  | {
      ok: true;
      specVersion: string;
      fieldCount: number;
      bnbQuoteSupported: boolean;
    }
  | {
      ok: false;
      reason: "invalid_address" | "no_code" | "not_v2_factory";
      detail?: string;
    };

/** Probe factory on the given BSC network's public RPC (independent of wallet chain). */
export async function probeCodegenFactory(
  factoryAddress: string,
  chainId: FlapLaunchNetworkId = DEFAULT_LAUNCH_NETWORK.chainId
): Promise<FactoryProbeResult> {
  if (!isAddress(factoryAddress)) {
    return { ok: false, reason: "invalid_address" };
  }

  const address = factoryAddress as Hex;
  const client = flapPublicClient(chainId);
  const net = getFlapNetwork(chainId);

  try {
    const bytecode = await client.getBytecode({ address });
    if (!bytecode || bytecode === "0x") {
      return {
        ok: false,
        reason: "no_code",
        detail: `No contract at this address on ${net.label} (chain ${chainId}).`,
      };
    }

    const [schema, specVersion, bnbQuoteSupported] = await Promise.all([
      client.readContract({
        address,
        abi: CODEGEN_FACTORY_ABI,
        functionName: "vaultDataSchema",
      }),
      client.readContract({
        address,
        abi: CODEGEN_FACTORY_ABI,
        functionName: "factorySpecVersion",
      }),
      client.readContract({
        address,
        abi: CODEGEN_FACTORY_ABI,
        functionName: "isQuoteTokenSupported",
        args: ["0x0000000000000000000000000000000000000000"],
      }),
    ]);

    if (!specVersion.startsWith("v2")) {
      return {
        ok: false,
        reason: "not_v2_factory",
        detail: `factorySpecVersion returned ${specVersion}.`,
      };
    }

    return {
      ok: true,
      specVersion,
      fieldCount: schema.fields.length,
      bnbQuoteSupported,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "not_v2_factory",
      detail: err instanceof Error ? err.message.split("\n")[0] : "vaultDataSchema call failed",
    };
  }
}

/** @deprecated Prefer probeCodegenFactory(address, 97). */
export async function probeCodegenFactoryOnTestnet(factoryAddress: string): Promise<FactoryProbeResult> {
  return probeCodegenFactory(factoryAddress, 97);
}
