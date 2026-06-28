import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Rocket } from "lucide-react";
import { bscTestnet } from "viem/chains";
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { Button } from "./ui/button";
import { SANDBOX_DEPLOYER_ABI, parseSandboxDeployReceipt } from "../lib/deploy-vault";
import {
  explorerAddressUrl,
  explorerTxUrl,
  getSandboxDeployerAddress,
  loadStudioConfig,
  type StudioConfig,
} from "../lib/studio-config";

type Props = {
  deployable: boolean;
  creationBytecode: string | null;
};

export default function DeployVaultPanel({ deployable, creationBytecode }: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [result, setResult] = useState<{ vault: string; taxToken: string; txHash: string } | null>(null);

  const { writeContract, data: txHash, isPending: isSending, error: writeError, reset } = useWriteContract();

  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: bscTestnet.id,
  });

  useEffect(() => {
    void loadStudioConfig().then(setConfig);
  }, []);

  useEffect(() => {
    if (!isSuccess || !receipt || !config) return;
    const deployer = getSandboxDeployerAddress(config);
    if (!deployer) return;
    const parsed = parseSandboxDeployReceipt(receipt.logs, deployer);
    if (parsed && txHash) {
      setResult({
        vault: parsed.vault,
        taxToken: parsed.taxToken,
        txHash,
      });
    }
  }, [isSuccess, receipt, config, txHash]);

  useEffect(() => {
    if (writeError) setDeployError(writeError.message.split("\n")[0] ?? "Transaction failed");
  }, [writeError]);

  const deployerAddress = config ? getSandboxDeployerAddress(config) : null;
  const onTestnet = chainId === bscTestnet.id;
  const busy = isSending || isConfirming || isSwitching;

  const onDeploy = useCallback(() => {
    setDeployError(null);
    setResult(null);
    reset();

    if (!deployable || !creationBytecode) {
      setDeployError("Vault is not deploy-ready or bytecode is missing.");
      return;
    }
    if (!isConnected || !address) {
      setDeployError("Connect MetaMask first.");
      return;
    }
    if (!deployerAddress) {
      setDeployError(
        "Sandbox deployer address not configured. Deploy CodegenVaultSandboxDeployer to BSC testnet and set sandboxDeployer in config.json."
      );
      return;
    }
    if (!onTestnet) {
      switchChain({ chainId: bscTestnet.id });
      return;
    }

    writeContract({
      address: deployerAddress,
      abi: SANDBOX_DEPLOYER_ABI,
      functionName: "deployVault",
      args: [creationBytecode as `0x${string}`, "0x0000000000000000000000000000000000000000"],
      chainId: bscTestnet.id,
    });
  }, [
    deployable,
    creationBytecode,
    isConnected,
    address,
    deployerAddress,
    onTestnet,
    switchChain,
    writeContract,
    reset,
  ]);

  if (!deployable) return null;

  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">Deploy vault to BSC testnet</p>
          <p className="mt-0.5 text-muted-foreground">
            You pay gas from your MetaMask wallet (testnet BNB). Auto-mints 1M STAX to your wallet for holder
            checks. Not a Flap token launch.
          </p>
          {config?.bscTestnetFaucet && (
            <p className="mt-1 text-muted-foreground">
              Need testnet BNB?{" "}
              <a
                href={config.bscTestnetFaucet}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                drip.tools faucet
              </a>
              {config.flapTestnet && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={config.flapTestnet}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    testnet.flap.sh
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={busy || !creationBytecode}
          onClick={onDeploy}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
          {busy
            ? isConfirming
              ? "Confirming…"
              : isSwitching
                ? "Switch network…"
                : "Sending…"
            : onTestnet
              ? "Deploy vault"
              : "Switch to testnet & deploy"}
        </Button>
      </div>

      {!deployerAddress && (
        <p className="mt-2 text-warning">
          Missing <code className="font-mono">sandboxDeployer</code> in config.json. Run{" "}
          <code className="font-mono">forge script script/testnet/bnb/DeploySandboxDeployer.s.sol --broadcast</code>{" "}
          on BSC testnet, then paste the address.
        </p>
      )}

      {deployError && <p className="mt-2 text-destructive">{deployError}</p>}

      {result && (
        <div className="mt-2 space-y-1 rounded-md border border-border/60 bg-background/50 p-2 font-mono text-[0.68rem]">
          <p>
            Vault:{" "}
            <a
              href={explorerAddressUrl(config?.bscTestnetExplorer, result.vault)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {result.vault}
              <ExternalLink className="ml-0.5 inline size-3" />
            </a>
          </p>
          <p>
            Tax token (STAX):{" "}
            <a
              href={explorerAddressUrl(config?.bscTestnetExplorer, result.taxToken)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {result.taxToken}
            </a>
          </p>
          <p>
            Tx:{" "}
            <a
              href={explorerTxUrl(config?.bscTestnetExplorer, result.txHash)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {result.txHash.slice(0, 14)}…
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
