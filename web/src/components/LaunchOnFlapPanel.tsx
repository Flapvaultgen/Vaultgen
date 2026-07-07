import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, RefreshCw, Rocket, ShieldCheck } from "lucide-react";
import { formatEther, parseEther } from "viem";
import { bscTestnet } from "viem/chains";
import { waitForTransactionReceipt } from "wagmi/actions";
import { useAccount, useChainId, useSendTransaction, useSwitchChain } from "wagmi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useI18n } from "../lib/i18n/context";
import { CODEGEN_VAULT_FACTORY_CREATION_CODE } from "../lib/flap-artifacts";
import { probeCodegenFactoryOnTestnet, type FactoryProbeResult } from "../lib/flap-factory";
import {
  KNOWN_RPC_GAS_CAP,
  MAX_DEPLOYED_BYTECODE_SIZE,
  REGISTER_FUNCTION_SIGNATURE,
  checkRegisterPayload,
  creationBytecodeByteLength,
  decodeRegisterRevert,
  exceedsDeployedBytecodeLimit,
  exceedsKnownRpcGasCap,
  isUsableCreationBytecode,
  preflightRegisterVault,
  readRegisteredVault,
  registerVaultForFlap,
  registerVaultGasLimit,
} from "../lib/flap-register";
import { launchCodegenTokenOnTestnet } from "../lib/flap-launch";
import {
  DEFAULT_LAUNCH_TAX_BPS,
  LAUNCH_CHAIN_ID,
  LAUNCH_FUNCTION_SIGNATURE,
  LAUNCH_PORTAL_ADDRESS,
  buildLaunchCallContext,
  checkLaunchPayload,
  decodeLaunchRevert,
} from "../lib/launch-validation";
import { saveLaunchStatus, type PersistedVaultState } from "../lib/chat-api";
import { uploadTokenMeta } from "../lib/flap-meta";
import { fileToThumbnailDataUrl } from "../lib/token-image";
import { createLaunchedTokenRecord, gmgnTokenUrl } from "../lib/tokens-api";
import { copyText } from "../lib/launch-utils";
import { wagmiConfig } from "../lib/wagmi";
import {
  clearCodegenFactoryAddress,
  explorerAddressUrl,
  explorerTxUrl,
  factoryArtifactFingerprint,
  flapLaunchUrl,
  flapTaxTokenUrl,
  getCachedFactoryAddress,
  getConfiguredFactoryAddress,
  getStoredFactoryArtifactFingerprint,
  loadLaunchedToken,
  loadStudioConfig,
  loadVaultBytecode,
  saveCodegenFactoryAddress,
  saveLaunchedToken,
  saveVaultBytecode,
  type LaunchedTokenRecord,
  type StudioConfig,
} from "../lib/studio-config";

type Props = {
  launchReady: boolean;
  deployReady: boolean;
  deployBlockReason: string | null;
  running: boolean;
  contractName: string;
  vaultDescription: string;
  creationBytecode: string | null;
  /** Deployed (runtime) bytecode size in bytes, from the compiled artifact — must stay ≤24,576 (EIP-170)
   *  or the vault will always fail to deploy on-chain (DeployFailed), regardless of network/retries. */
  deployedBytecodeSize?: number | null;
  /** AI-generated custom UI package (JSON-serialized VaultUiArtifact) — persisted with the launched
   *  token record so the /tokens/:id page can render it sandboxed. */
  uiArtifactJson?: string | null;
  /** When set, every deploy/register/launch step is persisted to the database for this chat/run. */
  chatId?: string;
  runId?: string | null;
  /**
   * Database-backed factory/register/launch state for this chat (from
   * generated_artifacts, not localStorage) — the source of truth that makes
   * this panel work the same on any device or browser.
   */
  persistedVaultState?: PersistedVaultState | null;
};

type LaunchPhase = "idle" | "factory" | "register" | "switching" | "launching";

const CURRENT_FACTORY_FP = factoryArtifactFingerprint(CODEGEN_VAULT_FACTORY_CREATION_CODE);

function payloadFingerprint(bytecode: string | null): string {
  if (!bytecode?.startsWith("0x")) return "";
  return `${bytecode.length}:${bytecode.slice(-16)}`;
}

function buildOnChainDescription(contractName: string, vaultDescription: string): string {
  const firstLine = (vaultDescription || "").split("\n")[0]!.trim();
  const text = `${contractName}: ${firstLine}`.trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

export default function LaunchOnFlapPanel({
  launchReady,
  deployReady,
  deployBlockReason,
  running,
  contractName,
  vaultDescription,
  creationBytecode,
  deployedBytecodeSize = null,
  uiArtifactJson = null,
  chatId,
  runId,
  persistedVaultState,
}: Props) {
  const { dict } = useI18n();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [factoryAddress, setFactoryAddress] = useState<`0x${string}` | null>(null);
  const [factoryProbe, setFactoryProbe] = useState<FactoryProbeResult | null>(null);
  const [probingFactory, setProbingFactory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [preflightState, setPreflightState] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const [launchPreflightState, setLaunchPreflightState] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const [registeredOnChain, setRegisteredOnChain] = useState(false);
  const [registeredDescription, setRegisteredDescription] = useState<string | null>(null);
  const [launchLastError, setLaunchLastError] = useState<string | null>(null);
  const [launchLastRaw, setLaunchLastRaw] = useState<string | null>(null);
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [copied, setCopied] = useState(false);
  const [factoryTx, setFactoryTx] = useState<string | null>(null);
  const [registerTx, setRegisterTx] = useState<string | null>(null);
  const [registeredKey, setRegisteredKey] = useState<string>("");
  const [checkingReg, setCheckingReg] = useState(false);
  const lastPayloadRef = useRef("");

  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [launchProgressMsg, setLaunchProgressMsg] = useState<string | null>(null);

  // Every launch-status write carries the wallet's signed session token
  // (attached automatically) — the server rejects writes to a chat owned by
  // a different wallet.
  const persistLaunchStatus = useCallback(
    (metadata: Record<string, unknown>) => {
      if (!chatId || !runId) return;
      void saveLaunchStatus(chatId, runId, metadata).catch(() => undefined);
    },
    [chatId, runId]
  );
  const [launched, setLaunched] = useState<LaunchedTokenRecord | null>(null);

  // Token metadata (flap.sh reads image/description/socials from an IPFS CID
  // pinned via Flap's own upload API) + optional initial dev buy.
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [tokenDescription, setTokenDescription] = useState("");
  const [tokenWebsite, setTokenWebsite] = useState("");
  const [tokenTwitter, setTokenTwitter] = useState("");
  const [tokenTelegram, setTokenTelegram] = useState("");
  const [devBuyBnb, setDevBuyBnb] = useState("");
  const [metaCid, setMetaCid] = useState<string | null>(null);

  // Manual fallback: the generated bytecode can go missing (different browser,
  // cleared localStorage, older persisted result) even though the contract
  // itself is deploy-ready. Let the user paste their own copy of the same
  // creation bytecode instead of being fully blocked.
  const [bytecodeDraft, setBytecodeDraft] = useState("");
  const [manualBytecode, setManualBytecode] = useState<string | null>(null);
  const [bytecodeSaveError, setBytecodeSaveError] = useState<string | null>(null);

  // Priority for "which factory build is this address": explicit deploy-time
  // config override > this chat's database record > this browser's local
  // cache. Getting this order right matters — a stale localStorage entry
  // from a previous browser session must never outrank a fresher database
  // record (that was the actual bug: the old, unfixed `getCodegenFactoryAddress`
  // silently fell back to localStorage *inside* itself, so it always "won"
  // over the database value it was supposedly deferring to).
  const configuredFactory = getConfiguredFactoryAddress(config ?? {});
  const dbFactory = persistedVaultState?.factoryAddress ?? null;
  const dbFactoryValid = dbFactory && /^0x[a-fA-F0-9]{40}$/.test(dbFactory);
  const factoryFingerprint = configuredFactory
    ? CURRENT_FACTORY_FP // an explicit override is always treated as current
    : dbFactoryValid
      ? persistedVaultState!.factoryArtifactFingerprint
      : getStoredFactoryArtifactFingerprint();
  const factoryOutdated = Boolean(factoryAddress) && factoryFingerprint !== CURRENT_FACTORY_FP;

  const storedBytecode = loadVaultBytecode(contractName);
  // Priority: the live generation result, then the database record for this
  // chat (works on any device/browser), then this browser's local cache,
  // then whatever the user just pasted in this session.
  const dbBytecode = persistedVaultState?.creationBytecode ?? null;
  const effectiveBytecode = isUsableCreationBytecode(creationBytecode)
    ? creationBytecode
    : isUsableCreationBytecode(dbBytecode)
      ? dbBytecode
      : isUsableCreationBytecode(storedBytecode)
        ? storedBytecode
        : isUsableCreationBytecode(manualBytecode)
          ? manualBytecode
          : creationBytecode;
  const bytecodeMissing = !isUsableCreationBytecode(effectiveBytecode);

  const useManualBytecode = useCallback(() => {
    const trimmed = bytecodeDraft.trim();
    const normalized = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`;
    const issue = checkRegisterPayload(normalized);
    if (issue) {
      setBytecodeSaveError(issue.message);
      return;
    }
    setBytecodeSaveError(null);
    setManualBytecode(normalized);
    saveVaultBytecode(contractName, normalized);
    persistLaunchStatus({
      status: "bytecode_provided",
      contractName,
      creationBytecode: normalized,
      at: new Date().toISOString(),
    });
  }, [bytecodeDraft, contractName, persistLaunchStatus]);

  const payloadKey = payloadFingerprint(effectiveBytecode);
  const isRegistered = registeredKey !== "" && registeredKey === payloadKey;
  const vaultChanged =
    Boolean(lastPayloadRef.current) && lastPayloadRef.current !== payloadKey && !running;

  useEffect(() => {
    void loadStudioConfig().then((c) => {
      setConfig(c);
      const configured = getConfiguredFactoryAddress(c);
      const dbFactory = persistedVaultState?.factoryAddress;
      const dbIsAddress = dbFactory && /^0x[a-fA-F0-9]{40}$/.test(dbFactory);
      // Config (explicit deploy-time override) wins; otherwise the database
      // record for this chat outranks this browser's local cache, which is
      // only a same-browser instant-paint fallback for offline/pre-load use.
      setFactoryAddress(configured ?? (dbIsAddress ? (dbFactory as `0x${string}`) : getCachedFactoryAddress()));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedVaultState?.factoryAddress]);

  // Prefill name/symbol from the contract name when a fresh vault arrives.
  useEffect(() => {
    if (!contractName) return;
    setTokenName((prev) => prev || contractName.replace(/Vault$/, ""));
    setTokenSymbol((prev) => prev || contractName.replace(/[a-z]/g, "").slice(0, 6) || "VAULT");
  }, [contractName]);

  useEffect(() => {
    if (!running && payloadKey) lastPayloadRef.current = payloadKey;
  }, [payloadKey, running]);

  useEffect(() => {
    if (!factoryAddress) {
      setFactoryProbe(null);
      return;
    }
    let cancelled = false;
    setProbingFactory(true);
    void probeCodegenFactoryOnTestnet(factoryAddress).then((result) => {
      if (!cancelled) {
        setFactoryProbe(result);
        setProbingFactory(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [factoryAddress]);

  // Read registration status from chain — the factory tracks one registration
  // per wallet, so a matching on-chain description (survives page reload)
  // is treated as "this vault is registered"; a mismatch means some other
  // vault occupies the slot and needs re-registering.
  useEffect(() => {
    if (!factoryAddress || !address || factoryOutdated) return;
    let cancelled = false;
    setCheckingReg(true);
    void readRegisteredVault(factoryAddress, address)
      .then((res) => {
        if (cancelled) return;
        if (!res.registered) {
          setRegisteredKey("");
          setRegisteredOnChain(false);
          setRegisteredDescription(null);
          return;
        }
        const expected = buildOnChainDescription(contractName, vaultDescription);
        setRegisteredDescription(res.description);
        setRegisteredOnChain(true);
        if (res.description === expected) setRegisteredKey(payloadKey);
        else setRegisteredKey("");
      })
      .finally(() => {
        if (!cancelled) setCheckingReg(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryAddress, address, factoryOutdated, registerTx, contractName, vaultDescription]);

  // Restore a previously launched token: this wallet's local record first,
  // then the database record for this chat (works across devices / wallets).
  useEffect(() => {
    const dbLaunched = persistedVaultState?.launched ?? null;
    if (address && contractName) {
      setLaunched(loadLaunchedToken(contractName, address) ?? dbLaunched);
      return;
    }
    setLaunched(dbLaunched);
  }, [address, contractName, persistedVaultState?.launched]);

  // Provisionally trust the database's "registered" record for this exact
  // payload immediately on load — the on-chain read effect above still runs
  // and is the final authority, this just avoids a flash of "not registered"
  // while that RPC round trip is in flight.
  useEffect(() => {
    if (
      persistedVaultState?.registeredPayloadFingerprint &&
      persistedVaultState.registeredPayloadFingerprint === payloadKey
    ) {
      if (registeredKey === "") setRegisteredKey(payloadKey);
      if (!registerTx && persistedVaultState.registeredTxHash) setRegisterTx(persistedVaultState.registeredTxHash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedVaultState?.registeredPayloadFingerprint, persistedVaultState?.registeredTxHash, payloadKey]);

  const onTestnet = chainId === bscTestnet.id;
  const busy = phase !== "idle" || isSwitching || running;
  const flapBase = config?.flapTestnet ?? "https://testnet.flap.sh";
  const flapLaunchPage = factoryAddress ? flapLaunchUrl(flapBase, factoryAddress) : flapLaunchUrl(flapBase, "");

  const ensureTestnet = useCallback(async () => {
    if (onTestnet) return true;
    setPhase("switching");
    try {
      await switchChainAsync({ chainId: bscTestnet.id });
      setPhase("idle");
      return true;
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Failed to switch to BSC testnet.");
      return false;
    }
  }, [onTestnet, switchChainAsync]);

  const deployFactory = useCallback(async () => {
    setError(null);
    setErrorRaw(null);
    if (!isConnected || !address) {
      setError("Connect MetaMask first.");
      return;
    }
    if (!(await ensureTestnet())) return;

    setPhase("factory");
    try {
      const hash = await sendTransactionAsync({
        chainId: bscTestnet.id,
        data: CODEGEN_VAULT_FACTORY_CREATION_CODE,
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: bscTestnet.id });
      const deployed = receipt.contractAddress;
      if (!deployed) throw new Error("Factory deploy did not return a contract address.");
      saveCodegenFactoryAddress(deployed, CURRENT_FACTORY_FP);
      setFactoryAddress(deployed);
      setFactoryTx(hash);
      setRegisteredKey("");
      setRegisterTx(null);
      persistLaunchStatus({
        status: "factory_deployed",
        contractName,
        factoryAddress: deployed,
        factoryArtifactFingerprint: CURRENT_FACTORY_FP,
        factoryTxHash: hash,
        wallet: address,
        chainId: bscTestnet.id,
        at: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message.split("\n")[0] : "Factory deploy failed.");
    } finally {
      setPhase("idle");
    }
  }, [address, contractName, ensureTestnet, isConnected, persistLaunchStatus, sendTransactionAsync]);

  const registerVault = useCallback(async () => {
    setError(null);
    setErrorRaw(null);
    if (!isConnected || !address) {
      setError("Connect MetaMask first.");
      return;
    }
    if (!factoryAddress) {
      setError("Deploy the factory first.");
      return;
    }
    if (factoryOutdated) {
      setError("Redeploy the factory (old build) before registering.");
      return;
    }
    // Block before any wallet prompt when the payload can't be real compiler
    // output (missing, 20-byte address, truncated hex, oversized...).
    const payloadIssue = checkRegisterPayload(effectiveBytecode);
    if (payloadIssue) {
      setError(payloadIssue.message);
      return;
    }
    if (!(await ensureTestnet())) return;

    const desc = buildOnChainDescription(contractName, vaultDescription);

    // Preflight simulation on the public RPC: catches reverts (with decoded
    // custom errors) before the user is asked to sign or pay gas.
    setPhase("register");
    setPreflightState("running");
    const preflight = await preflightRegisterVault(
      factoryAddress,
      effectiveBytecode,
      desc,
      address as `0x${string}`
    );
    if (!preflight.ok) {
      setPreflightState("failed");
      setError(preflight.reason);
      setErrorRaw(preflight.raw);
      setPhase("idle");
      return;
    }
    setPreflightState("ok");

    try {
      const hash = await registerVaultForFlap(factoryAddress, effectiveBytecode as `0x${string}`, desc);
      setRegisterTx(hash);
      setRegisteredKey(payloadKey);
      persistLaunchStatus({
        status: "registered",
        contractName,
        registerTxHash: hash,
        registeredPayloadFingerprint: payloadKey,
        factoryAddress,
        factoryArtifactFingerprint: CURRENT_FACTORY_FP,
        creationBytecode: effectiveBytecode,
        wallet: address,
        chainId: bscTestnet.id,
        at: new Date().toISOString(),
      });
    } catch (err) {
      const decoded = decodeRegisterRevert(err, {
        chainId: bscTestnet.id,
        factoryAddress,
        wallet: address,
        bytecodeBytes: creationBytecodeByteLength(effectiveBytecode),
        descriptionLength: desc.length,
      });
      setError(decoded.reason);
      setErrorRaw(decoded.raw);
    } finally {
      setPhase("idle");
    }
  }, [
    address,
    contractName,
    effectiveBytecode,
    ensureTestnet,
    factoryAddress,
    factoryOutdated,
    isConnected,
    payloadKey,
    persistLaunchStatus,
    vaultDescription,
  ]);

  const launchToken = useCallback(async () => {
    setError(null);
    setErrorRaw(null);
    setLaunchLastError(null);
    setLaunchLastRaw(null);
    if (!isConnected || !address) {
      setError("Connect MetaMask first.");
      return;
    }
    if (!factoryAddress || !isRegistered) {
      setError("Register the vault on-chain first.");
      return;
    }
    if (!launchReady) {
      setError(deployBlockReason ?? "Launch is blocked until the vault pipeline is complete.");
      return;
    }
    const name = tokenName.trim();
    const symbol = tokenSymbol.trim().toUpperCase();
    const expectedDescription = buildOnChainDescription(contractName, vaultDescription);

    // Dev buy: BNB string → wei. Portal spends msg.value (>= quoteAmt) buying at launch.
    let devBuyWei = 0n;
    const devBuyTrimmed = devBuyBnb.trim();
    if (devBuyTrimmed) {
      try {
        devBuyWei = parseEther(devBuyTrimmed);
      } catch {
        setError(`Dev buy "${devBuyTrimmed}" is not a valid BNB amount.`);
        return;
      }
    }

    const payloadIssue = checkLaunchPayload({
      walletAddress: address,
      chainId,
      factoryAddress,
      tokenName: name,
      tokenSymbol: symbol,
      registeredOnChain: isRegistered,
      registeredDescription,
      expectedDescription,
      vaultDataMode: "registered",
      devBuyWei,
    });
    if (payloadIssue) {
      setError(payloadIssue.message);
      return;
    }
    if (!(await ensureTestnet())) return;

    setPhase("launching");

    // Metadata: flap.sh only shows image/description/website/X/Telegram when the
    // meta field carries an IPFS CID pinned through Flap's own upload API.
    let cid = metaCid;
    // Small local copy of the icon so our own tokens page can show it instantly,
    // without depending on an IPFS gateway being reachable from the browser.
    const imageDataUrl = tokenImage ? await fileToThumbnailDataUrl(tokenImage) : null;
    if (!cid && tokenImage) {
      setLaunchProgressMsg("Uploading token image + metadata to Flap IPFS…");
      try {
        cid = await uploadTokenMeta({
          imageFile: tokenImage,
          description: tokenDescription.trim() || name,
          website: tokenWebsite,
          twitter: tokenTwitter,
          telegram: tokenTelegram,
          creator: address,
        });
        setMetaCid(cid);
      } catch (err) {
        setPhase("idle");
        setLaunchProgressMsg(null);
        setError(err instanceof Error ? err.message : "Metadata upload failed.");
        return;
      }
    }

    setLaunchPreflightState("running");
    setLaunchProgressMsg("Finding vanity address and simulating launch…");

    const launchInput = {
      name,
      symbol,
      factoryAddress,
      vaultDataMode: "registered" as const,
      registeredOnChain: isRegistered,
      registeredDescription,
      expectedDescription,
      buyTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
      sellTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
      metaCid: cid,
      devBuyWei,
    };

    try {
      const result = await launchCodegenTokenOnTestnet(launchInput, {
        onProgress: setLaunchProgressMsg,
      });
      setLaunchPreflightState("ok");
      const record: LaunchedTokenRecord = {
        tokenAddress: result.token,
        vaultAddress: result.vault,
        factoryAddress,
        txHash: result.txHash,
        name,
        symbol,
        launchedAt: new Date().toISOString(),
      };
      saveLaunchedToken(contractName, address, record);
      setLaunched(record);
      const launchUrl = flapTaxTokenUrl(flapBase, record.tokenAddress);
      const gmgn = gmgnTokenUrl(bscTestnet.id, record.tokenAddress);
      persistLaunchStatus({
        status: "launched",
        contractName,
        wallet: address,
        chainId: bscTestnet.id,
        launchUrl,
        buyTaxBps: DEFAULT_LAUNCH_TAX_BPS,
        sellTaxBps: DEFAULT_LAUNCH_TAX_BPS,
        registerTxHash: registerTx,
        ...record,
      });
      void createLaunchedTokenRecord({
        chatId: chatId ?? null,
        runId: runId ?? null,
        walletAddress: address,
        chainId: bscTestnet.id,
        tokenName: name,
        tokenSymbol: symbol,
        tokenAddress: result.token,
        vaultAddress: result.vault,
        factoryAddress,
        launchContractAddress: LAUNCH_PORTAL_ADDRESS,
        registerTxHash: registerTx,
        launchTxHash: result.txHash,
        buyTaxBps: DEFAULT_LAUNCH_TAX_BPS,
        sellTaxBps: DEFAULT_LAUNCH_TAX_BPS,
        status: "launched",
        launchUrl,
        gmgnUrl: gmgn,
        metadata: {
          contractName,
          registeredPayloadFingerprint: payloadKey,
          registeredDescription,
          metaCid: cid,
          devBuyWei: devBuyWei.toString(),
          description: tokenDescription.trim() || null,
          website: tokenWebsite.trim() || null,
          twitter: tokenTwitter.trim() || null,
          telegram: tokenTelegram.trim() || null,
          imageDataUrl,
          uiArtifact: uiArtifactJson || null,
        },
      }).catch(() => undefined);
    } catch (err) {
      setLaunchPreflightState("failed");
      const ctx = buildLaunchCallContext({
        wallet: address,
        factoryAddress: factoryAddress!,
        tokenName: name,
        tokenSymbol: symbol,
        buyTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
        sellTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
        vaultDataMode: "registered",
        vaultDataBytes: 0,
        registeredOnChain: isRegistered,
        devBuyWei,
        metaCid: cid,
      });
      const decoded = decodeLaunchRevert(err, ctx);
      setError(decoded.reason);
      setErrorRaw(decoded.raw);
      setLaunchLastError(decoded.reason);
      setLaunchLastRaw(decoded.raw);
    } finally {
      setPhase("idle");
      setLaunchProgressMsg(null);
    }
  }, [
    address,
    chatId,
    contractName,
    deployBlockReason,
    devBuyBnb,
    ensureTestnet,
    factoryAddress,
    flapBase,
    isConnected,
    isRegistered,
    launchReady,
    metaCid,
    payloadKey,
    persistLaunchStatus,
    registerTx,
    registeredDescription,
    runId,
    tokenDescription,
    tokenImage,
    tokenName,
    tokenSymbol,
    tokenTelegram,
    tokenTwitter,
    tokenWebsite,
    vaultDescription,
    chainId,
  ]);

  const onCopyFactory = useCallback(async () => {
    if (factoryAddress && (await copyText(factoryAddress))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [factoryAddress]);

  const openFlap = useCallback(() => {
    window.open(flapLaunchPage, "_blank", "noopener,noreferrer");
  }, [flapLaunchPage]);

  const resetFactory = useCallback(() => {
    clearCodegenFactoryAddress();
    setFactoryAddress(null);
    setFactoryProbe(null);
    setFactoryTx(null);
    setRegisterTx(null);
    setRegisteredKey("");
    setError(null);
    // Must also clear the database record — otherwise persistedVaultState
    // (which outranks this browser's local cache) would immediately bring
    // the "cleared" factory address right back on the next artifact reload.
    persistLaunchStatus({
      status: "factory_cleared",
      contractName,
      at: new Date().toISOString(),
    });
  }, [contractName, persistLaunchStatus]);

  // Render whenever the contract itself is deploy-ready (compiled, safe,
  // tested, in-scope) even if bytecode is currently missing — that state
  // gets its own "paste your bytecode" recovery UI below instead of a blank
  // panel.
  if (!deployReady && !launchReady && !running) return null;

  const bytecodeBytes = creationBytecodeByteLength(effectiveBytecode);
  const payloadIssue = checkRegisterPayload(effectiveBytecode);
  const registerGas = payloadIssue === null ? registerVaultGasLimit(effectiveBytecode as `0x${string}`) : null;
  const gasCapRisk = payloadIssue === null && exceedsKnownRpcGasCap(effectiveBytecode as `0x${string}`);
  const oversizedDeployedBytecode = exceedsDeployedBytecodeLimit(deployedBytecodeSize);
  const onChainDescription = buildOnChainDescription(contractName, vaultDescription);
  const launchPayloadIssue = checkLaunchPayload({
    walletAddress: address,
    chainId,
    factoryAddress,
    tokenName,
    tokenSymbol,
    registeredOnChain: isRegistered,
    registeredDescription,
    expectedDescription: onChainDescription,
    vaultDataMode: "registered",
  });
  const canRegister = Boolean(
    factoryAddress && !factoryOutdated && payloadIssue === null && !oversizedDeployedBytecode
  );
  const canLaunch = Boolean(
    launchReady &&
      factoryAddress &&
      !factoryOutdated &&
      isRegistered &&
      isConnected &&
      onTestnet &&
      launchPayloadIssue === null &&
      tokenName.trim() &&
      tokenSymbol.trim()
  );

  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs">
      <div className="space-y-1">
        <p className="font-medium text-foreground">Launch on Flap (BSC testnet)</p>
        <p className="text-muted-foreground">
          Deploy the factory, register your vault on-chain (typically well under 10M gas — keep enough tBNB), then
          launch the token straight from here — the vault attaches automatically.
        </p>
      </div>

      {factoryOutdated && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3.5" />
          Saved factory is an old build — <strong className="text-foreground">Redeploy factory</strong> first
          (your old address won&apos;t have the register/no-paste flow).
        </p>
      )}

      {running && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Regenerating vault bytecode — wait before registering.
        </p>
      )}

      {vaultChanged && !running && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-amber-300">
          <AlertTriangle className="size-3.5" />
          Vault code changed — <strong className="text-foreground">re-register</strong>, then launch a new token.
        </p>
      )}

      {!deployReady && !running && deployBlockReason && (
        <p className="mt-2 text-muted-foreground">Pipeline note: {deployBlockReason}</p>
      )}

      {bytecodeMissing && !running && (
        <div className="mt-3 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
          <p className="inline-flex items-center gap-1.5 text-amber-300">
            <AlertTriangle className="size-3.5" />
            Bytecode isn&apos;t attached to this session. Paste the exact creation bytecode for{" "}
            <span className="font-mono text-foreground">{contractName}</span> — you compile and provide it, the app
            never invents it.
          </p>
          <textarea
            value={bytecodeDraft}
            onChange={(e) => {
              setBytecodeDraft(e.target.value);
              setBytecodeSaveError(null);
            }}
            placeholder="0x608060405234801561001057600080fd5b50..."
            spellCheck={false}
            className="h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[0.65rem] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {bytecodeSaveError ?? "Saved locally to this browser once accepted; it never leaves your device until you sign a register transaction."}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={bytecodeDraft.trim().length === 0}
              onClick={useManualBytecode}
            >
              Use this bytecode
            </Button>
          </div>
        </div>
      )}

      {/* Step 1: factory */}
      <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground">1. CodegenVaultFactory</span>
          <div className="flex flex-wrap items-center gap-2">
            {factoryAddress && (
              <>
                <code className="font-mono text-[0.65rem]">{factoryAddress}</code>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  onClick={() => void onCopyFactory()}
                >
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  Copy
                </button>
                <a
                  href={explorerAddressUrl(config?.bscTestnetExplorer, factoryAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Explorer
                </a>
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant={factoryAddress ? "outline" : "default"}
              disabled={busy}
              onClick={() => void deployFactory()}
            >
              {phase === "factory" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {phase === "factory" ? "Deploying…" : factoryAddress ? "Redeploy factory" : "Deploy factory"}
            </Button>
            {factoryAddress && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={resetFactory}>
                Clear saved
              </Button>
            )}
          </div>
        </div>

        {factoryAddress && (
          <div className="text-[0.65rem]">
            {probingFactory ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Checking factory on BSC testnet…
              </span>
            ) : factoryProbe?.ok ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <Check className="size-3" />
                On-chain factory responds ({factoryProbe.specVersion})
                {factoryOutdated ? " — but studio build is newer, redeploy" : ""}
              </span>
            ) : factoryProbe && !factoryProbe.ok ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <AlertTriangle className="size-3" />
                {factoryProbe.reason === "no_code"
                  ? "No contract on BSC testnet — redeploy the factory."
                  : "Factory probe failed"}
                {factoryProbe.detail ? `: ${factoryProbe.detail}` : ""}
              </span>
            ) : null}
          </div>
        )}

        {factoryTx && (
          <p className="font-mono text-[0.65rem] text-muted-foreground">
            Factory tx:{" "}
            <a
              href={explorerTxUrl(config?.bscTestnetExplorer, factoryTx)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {factoryTx.slice(0, 14)}…
            </a>
          </p>
        )}
      </div>

      {/* Step 2: register */}
      <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground">
            2. Register vault on-chain
            {isRegistered && !vaultChanged ? <span className="ml-2 text-emerald-400">· registered</span> : null}
          </span>
          <Button type="button" size="sm" disabled={busy || !canRegister} onClick={() => void registerVault()}>
            {phase === "register" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            {phase === "register" ? "Registering…" : isRegistered ? "Re-register" : "Register vault"}
          </Button>
        </div>
        <p className="text-[0.65rem] text-muted-foreground">
          Writes <span className="font-mono">{contractName}</span> full compiler creation bytecode to the factory for
          your wallet (the factory expects bytes, not an address). Flap reads it at launch.
          {registerGas ? (
            <>
              {" "}
              Creation bytecode: <span className="font-mono">{bytecodeBytes.toLocaleString()} bytes</span> · gas limit{" "}
              <span className="font-mono">{registerGas.toLocaleString()}</span> (formula-based; BSC testnet can&apos;t
              estimate above 16M — unused gas is refunded)
            </>
          ) : null}
        </p>
        {payloadIssue && !running && (
          <p className="inline-flex items-start gap-1.5 text-[0.65rem] text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {payloadIssue.message}
          </p>
        )}
        {!payloadIssue && gasCapRisk && !running && (
          <p className="inline-flex items-start gap-1.5 text-[0.65rem] text-amber-300">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            This gas limit ({registerGas?.toLocaleString()}) exceeds the {KNOWN_RPC_GAS_CAP.toLocaleString()}-gas send
            cap every major public BSC RPC enforces. The factory stores bytecode cheaply enough that this shouldn&apos;t
            happen for a valid payload — it almost always means <strong className="text-foreground">factory in
            step 1 is outdated</strong>; redeploy it, then register again.
          </p>
        )}
        {oversizedDeployedBytecode && !running && (
          <p className="inline-flex items-start gap-1.5 text-[0.65rem] text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            This vault&apos;s deployed bytecode is{" "}
            <span className="font-mono">{deployedBytecodeSize?.toLocaleString()} bytes</span> — over the{" "}
            <span className="font-mono">{MAX_DEPLOYED_BYTECODE_SIZE.toLocaleString()}</span>-byte EIP-170 limit every
            EVM chain enforces. It can never deploy, on any network, no matter how many times you register/launch —
            regenerate a smaller version of this vault before continuing.
          </p>
        )}
        {preflightState === "running" && (
          <p className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Preflight: simulating registerVault on the public RPC (no gas spent)…
          </p>
        )}
        {preflightState === "ok" && (
          <p className="inline-flex items-center gap-1 text-[0.65rem] text-emerald-400">
            <Check className="size-3" />
            Preflight simulation passed — transaction sent to wallet.
          </p>
        )}
        {preflightState === "failed" && (
          <p className="inline-flex items-center gap-1 text-[0.65rem] text-destructive">
            <AlertTriangle className="size-3" />
            Preflight simulation failed — nothing was sent, no gas spent. Reason below.
          </p>
        )}
        {checkingReg && (
          <p className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Checking registration…
          </p>
        )}
        {registerTx && (
          <p className="font-mono text-[0.65rem] text-muted-foreground">
            Register tx:{" "}
            <a
              href={explorerTxUrl(config?.bscTestnetExplorer, registerTx)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {registerTx.slice(0, 14)}…
            </a>
          </p>
        )}
      </div>

      {/* Step 3: launch */}
      {launched ? (
        <div className="mt-3 space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5">
          <p className="inline-flex items-center gap-1.5 font-medium text-emerald-300">
            <Check className="size-3.5" />
            Launched — {launched.name} ({launched.symbol})
          </p>
          <div className="grid gap-1 text-[0.65rem] text-muted-foreground">
            <p>
              Token:{" "}
              <a
                href={explorerAddressUrl(config?.bscTestnetExplorer, launched.tokenAddress)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-primary hover:underline"
              >
                {launched.tokenAddress}
              </a>
            </p>
            <p>
              Vault:{" "}
              <a
                href={explorerAddressUrl(config?.bscTestnetExplorer, launched.vaultAddress)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-primary hover:underline"
              >
                {launched.vaultAddress}
              </a>
            </p>
            <p>
              Launch tx:{" "}
              <a
                href={explorerTxUrl(config?.bscTestnetExplorer, launched.txHash)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-primary hover:underline"
              >
                {launched.txHash.slice(0, 14)}…
              </a>
            </p>
          </div>
          <a
            href={flapTaxTokenUrl(flapBase, launched.tokenAddress)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            View on Flap <ExternalLink className="size-3" />
          </a>
        </div>
      ) : (
        <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <span className="font-medium text-foreground">3. Launch token on Flap</span>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Token name"
              value={tokenName}
              disabled={busy}
              onChange={(e) => setTokenName(e.target.value)}
              className="w-40"
            />
            <Input
              placeholder="Symbol"
              value={tokenSymbol}
              disabled={busy}
              onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
              className="w-24"
            />
            <Button
              type="button"
              size="sm"
              disabled={!canLaunch || busy || !tokenName.trim() || !tokenSymbol.trim()}
              onClick={() => void launchToken()}
              className="gap-2"
            >
              {phase === "launching" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Rocket className="size-3.5" />
              )}
              {phase === "launching" ? "Launching…" : "Launch token"}
            </Button>
          </div>

          {/* Token metadata — flap.sh shows image/description/socials only when
              the meta CID is pinned via Flap's upload API (funcs.flap.sh). */}
          <div className="space-y-2 rounded-md border border-border/40 bg-background/30 p-2">
            <p className="text-[0.65rem] font-medium text-foreground">
              Token page info (image, description, links — shown on flap.sh)
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-[0.65rem] hover:bg-secondary/40">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    setTokenImage(e.target.files?.[0] ?? null);
                    setMetaCid(null); // re-upload with the new image on next launch
                  }}
                />
                {tokenImage ? `Image: ${tokenImage.name}` : "Choose token image…"}
              </label>
              {metaCid && (
                <span className="font-mono text-[0.6rem] text-emerald-400">meta pinned: {metaCid.slice(0, 16)}…</span>
              )}
            </div>
            <textarea
              value={tokenDescription}
              onChange={(e) => {
                setTokenDescription(e.target.value);
                setMetaCid(null);
              }}
              placeholder="Token description shown on flap.sh"
              disabled={busy}
              className="h-14 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[0.65rem] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Website (optional)"
                value={tokenWebsite}
                disabled={busy}
                onChange={(e) => {
                  setTokenWebsite(e.target.value);
                  setMetaCid(null);
                }}
                className="w-48 text-[0.65rem]"
              />
              <Input
                placeholder="X / Twitter (optional)"
                value={tokenTwitter}
                disabled={busy}
                onChange={(e) => {
                  setTokenTwitter(e.target.value);
                  setMetaCid(null);
                }}
                className="w-44 text-[0.65rem]"
              />
              <Input
                placeholder="Telegram (optional)"
                value={tokenTelegram}
                disabled={busy}
                onChange={(e) => {
                  setTokenTelegram(e.target.value);
                  setMetaCid(null);
                }}
                className="w-40 text-[0.65rem]"
              />
            </div>
            {!tokenImage && (
              <p className="text-[0.6rem] text-muted-foreground">
                No image selected — token launches without metadata (blank image/description on flap.sh). Metadata
                can&apos;t be added after launch.
              </p>
            )}
          </div>

          {/* Dev buy — quoteAmt / msg.value: the portal buys this much of your token at launch. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Dev buy in BNB (optional, e.g. 0.05)"
              value={devBuyBnb}
              disabled={busy}
              onChange={(e) => setDevBuyBnb(e.target.value)}
              className="w-56 text-[0.65rem]"
            />
            <span className="text-[0.6rem] text-muted-foreground">
              Initial buy at launch — this amount of tBNB is sent with the launch tx (plus gas).
            </span>
          </div>

          {!canLaunch && (
            <p className="text-[0.65rem] text-muted-foreground">
              {!launchReady
                ? (deployBlockReason ?? "Complete the vault pipeline before launching.")
                : !isRegistered
                  ? "Register the vault on-chain first (step 2)."
                  : launchPayloadIssue?.message ?? "Connect wallet and switch to BSC testnet."}
            </p>
          )}
          {launchPreflightState === "running" && (
            <p className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Preflight: simulating newTokenV6WithVault on the public RPC (no gas spent until wallet confirms)…
            </p>
          )}
          {launchPreflightState === "ok" && (
            <p className="inline-flex items-center gap-1 text-[0.65rem] text-emerald-400">
              <Check className="size-3" />
              Launch preflight passed — token deployed on-chain.
            </p>
          )}
          {launchPreflightState === "failed" && (
            <p className="inline-flex items-center gap-1 text-[0.65rem] text-destructive">
              <AlertTriangle className="size-3" />
              Launch preflight failed — nothing was sent, no gas spent. Reason below.
            </p>
          )}
          {launchProgressMsg && (
            <p className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {launchProgressMsg}
            </p>
          )}
          <p className="text-[0.65rem] text-muted-foreground">
            5% buy/sell tax by default (adjustable manually on{" "}
            <button type="button" onClick={openFlap} className="text-primary hover:underline">
              testnet.flap.sh
            </button>{" "}
            instead if you need different economics).
          </p>
        </div>
      )}

      {isConnected && !onTestnet && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void ensureTestnet()}
          className="mt-2"
        >
          {phase === "switching" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Switch to BSC testnet
        </Button>
      )}
      {!isConnected && <p className="mt-2 text-muted-foreground">{dict.launchPanel.walletNotice}</p>}

      {error && (
        <div className="mt-2 space-y-1">
          <p className="inline-flex items-start gap-1.5 text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
          {errorRaw && errorRaw !== error && (
            <details className="text-[0.65rem] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">Raw error</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-background/60 p-1.5 font-mono">
                {errorRaw}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Registration diagnostics: everything needed to debug a failed register. */}
      <details className="mt-2 text-[0.65rem] text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Registration debug</summary>
        <div className="mt-1 grid gap-0.5 rounded border border-border/60 bg-background/60 p-1.5 font-mono">
          <span>function: {REGISTER_FUNCTION_SIGNATURE}</span>
          <span>factory: {factoryAddress ?? "not deployed"}</span>
          <span>chain: {bscTestnet.id} (wallet on {isConnected ? chainId : "not connected"})</span>
          <span>wallet: {address ?? "not connected"}</span>
          <span>
            creation bytecode: {bytecodeBytes.toLocaleString()} bytes
            {payloadIssue ? ` — INVALID (${payloadIssue.code})` : " — plausible compiler output"}
          </span>
          <span>
            bytecode source:{" "}
            {isUsableCreationBytecode(creationBytecode)
              ? "generated result"
              : isUsableCreationBytecode(storedBytecode)
                ? "browser storage"
                : isUsableCreationBytecode(manualBytecode)
                  ? "manually pasted"
                  : "none"}
          </span>
          <span>description: {buildOnChainDescription(contractName, vaultDescription).length} chars</span>
          <span>gas limit: {registerGas ? `${registerGas.toLocaleString()} (formula; RPC can't estimate >16M)` : "unavailable — payload invalid"}</span>
          <span>
            known RPC send cap ({KNOWN_RPC_GAS_CAP.toLocaleString()}):{" "}
            {gasCapRisk ? "at risk — many public nodes will reject the send" : "within range"}
          </span>
          <span>preflight: {preflightState}</span>
          <span>registered on-chain: {isRegistered ? "yes (matches current payload)" : "no / different payload"}</span>
        </div>
      </details>

      <details className="mt-2 text-[0.65rem] text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Launch debug</summary>
        <div className="mt-1 grid gap-0.5 rounded border border-border/60 bg-background/60 p-1.5 font-mono">
          <span>function: {LAUNCH_FUNCTION_SIGNATURE}</span>
          <span>portal: {LAUNCH_PORTAL_ADDRESS}</span>
          <span>chain: {LAUNCH_CHAIN_ID} (wallet on {isConnected ? chainId : "not connected"})</span>
          <span>wallet: {address ?? "not connected"}</span>
          <span>token name: {tokenName.trim() || "(empty)"}</span>
          <span>token symbol: {tokenSymbol.trim().toUpperCase() || "(empty)"}</span>
          <span>
            buy/sell tax: {DEFAULT_LAUNCH_TAX_BPS}/{DEFAULT_LAUNCH_TAX_BPS} bps (5% default from launch form)
          </span>
          <span>factory: {factoryAddress ?? "not deployed"}</span>
          <span>vaultData mode: registered (empty bytes — uses step-2 registration)</span>
          <span>registered on-chain: {registeredOnChain ? "yes" : "no"}</span>
          <span>registered description: {registeredDescription ? `${registeredDescription.slice(0, 48)}…` : "none"}</span>
          <span>register tx: {registerTx ?? "none"}</span>
          <span>meta CID: {metaCid ?? (tokenImage ? "uploads on launch" : "none — no image/description/socials")}</span>
          <span>
            dev buy (quoteAmt / msg.value):{" "}
            {(() => {
              try {
                const wei = devBuyBnb.trim() ? parseEther(devBuyBnb.trim()) : 0n;
                return `${formatEther(wei)} BNB (${wei.toString()} wei)`;
              } catch {
                return `invalid ("${devBuyBnb}")`;
              }
            })()}
          </span>
          <span>launch gate: {launchReady ? "open" : "blocked"}</span>
          <span>payload validation: {launchPayloadIssue ? `INVALID (${launchPayloadIssue.code})` : "ok"}</span>
          <span>preflight: {launchPreflightState}</span>
          <span>decoded last error: {launchLastError ?? "none"}</span>
          {launchLastRaw && launchLastRaw !== launchLastError && (
            <details>
              <summary className="cursor-pointer select-none hover:text-foreground">raw error</summary>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all">{launchLastRaw}</pre>
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
