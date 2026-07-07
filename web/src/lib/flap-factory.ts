import {
  createPublicClient,
  http,
  isAddress,
  type Hex,
} from "viem";
import { bscTestnet } from "viem/chains";

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

export const flapTestnetPublicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(),
});

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

/** Probe factory on BSC testnet public RPC (independent of wallet chain). */
export async function probeCodegenFactoryOnTestnet(
  factoryAddress: string
): Promise<FactoryProbeResult> {
  if (!isAddress(factoryAddress)) {
    return { ok: false, reason: "invalid_address" };
  }

  const address = factoryAddress as Hex;

  try {
    const bytecode = await flapTestnetPublicClient.getBytecode({ address });
    if (!bytecode || bytecode === "0x") {
      return {
        ok: false,
        reason: "no_code",
        detail: "No contract at this address on BSC testnet (chain 97).",
      };
    }

    const [schema, specVersion, bnbQuoteSupported] = await Promise.all([
      flapTestnetPublicClient.readContract({
        address,
        abi: CODEGEN_FACTORY_ABI,
        functionName: "vaultDataSchema",
      }),
      flapTestnetPublicClient.readContract({
        address,
        abi: CODEGEN_FACTORY_ABI,
        functionName: "factorySpecVersion",
      }),
      flapTestnetPublicClient.readContract({
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