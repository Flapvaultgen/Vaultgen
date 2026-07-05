/**
 * Chat persistence types shared by the chat store, chat routes, and run
 * manager. Shapes mirror supabase/schema.sql (camelCase in code, snake_case
 * in the database).
 */

/** One row per connected wallet (identification only — no signature auth yet). */
export type User = {
  id: string;
  walletAddress: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
};

export type ChatStatus = "active" | "archived";

export type Chat = {
  id: string;
  userId: string | null;
  title: string;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  archivedAt: string | null;
};

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";
export type ChatMessageStatus = "pending" | "streaming" | "completed" | "failed";

export type ChatMessage = {
  id: string;
  chatId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GenerationRunStatus = "pending" | "running" | "completed" | "failed";

export type GenerationRun = {
  id: string;
  chatId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  model: string | null;
  status: GenerationRunStatus;
  deliverable: string | null;
  scope: unknown | null;
  mechanicSpec: unknown | null;
  simulationReport: unknown | null;
  economicCritique: unknown | null;
  approximationReport: unknown | null;
  repairAttempts: unknown | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerationEventType =
  | "run_started"
  | "status"
  | "heartbeat"
  | "mechanic_spec"
  | "scope"
  | "design_questions"
  | "consent_required"
  | "code_delta"
  | "code_complete"
  | "scanner_result"
  | "simulation_report"
  | "economic_critique"
  | "repair_attempt"
  | "run_completed"
  | "run_failed";

export type GenerationEvent = {
  id: string;
  runId: string;
  chatId: string;
  eventType: GenerationEventType;
  sequence: number;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GeneratedArtifactType =
  | "solidity"
  | "mechanic_spec"
  | "test_file"
  | "simulation_report"
  | "economic_critique"
  | "approximation_report"
  | "vault_ui"
  | "launch_status";

export type GeneratedArtifact = {
  id: string;
  chatId: string;
  runId: string;
  artifactType: GeneratedArtifactType;
  name: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RepairAttemptRow = {
  id: string;
  runId: string;
  attemptNumber: number;
  reason: string;
  model: string | null;
  findingsAddressed: unknown[];
  compilePassed: boolean | null;
  scannersPassed: boolean | null;
  testsPassed: boolean | null;
  criticReran: boolean | null;
  remainingIssues: unknown[];
  createdAt: string;
};

/** Immediate response from POST /api/chats/start-generation. */
export type StartGenerationResponse = {
  chatId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  streamUrl: string;
};

// ── insert/update inputs ────────────────────────────────────────────────────

export type NewChat = { userId?: string | null; title?: string };
export type ChatUpdate = Partial<Pick<Chat, "title" | "status" | "lastMessageAt" | "archivedAt" | "userId">>;

export type NewChatMessage = {
  chatId: string;
  role: ChatMessageRole;
  content?: string;
  status?: ChatMessageStatus;
  metadata?: Record<string, unknown>;
};
export type ChatMessageUpdate = Partial<Pick<ChatMessage, "content" | "status" | "metadata">>;

export type NewGenerationRun = {
  chatId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  model?: string | null;
};
export type GenerationRunUpdate = Partial<
  Pick<
    GenerationRun,
    | "status"
    | "deliverable"
    | "scope"
    | "mechanicSpec"
    | "simulationReport"
    | "economicCritique"
    | "approximationReport"
    | "repairAttempts"
    | "error"
    | "completedAt"
  >
>;

export type NewGenerationEvent = {
  runId: string;
  chatId: string;
  eventType: GenerationEventType;
  sequence: number;
  message?: string | null;
  payload?: Record<string, unknown>;
};

export type NewGeneratedArtifact = {
  chatId: string;
  runId: string;
  artifactType: GeneratedArtifactType;
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type NewRepairAttemptRow = {
  runId: string;
  attemptNumber: number;
  reason: string;
  model?: string | null;
  findingsAddressed?: unknown[];
  compilePassed?: boolean | null;
  scannersPassed?: boolean | null;
  testsPassed?: boolean | null;
  criticReran?: boolean | null;
  remainingIssues?: unknown[];
};

export type LaunchedTokenStatus = "registered" | "launch_pending" | "launched" | "failed";

export type LaunchedToken = {
  id: string;
  chatId: string | null;
  runId: string | null;
  artifactId: string | null;
  walletAddress: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  vaultAddress: string | null;
  registeredVaultId: string | null;
  registeredVaultHash: string | null;
  factoryAddress: string | null;
  launchContractAddress: string | null;
  registerTxHash: string | null;
  launchTxHash: string | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  status: LaunchedTokenStatus;
  launchUrl: string | null;
  gmgnUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type NewLaunchedToken = {
  chatId?: string | null;
  runId?: string | null;
  artifactId?: string | null;
  walletAddress: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress?: string | null;
  vaultAddress?: string | null;
  registeredVaultId?: string | null;
  registeredVaultHash?: string | null;
  factoryAddress?: string | null;
  launchContractAddress?: string | null;
  registerTxHash?: string | null;
  launchTxHash?: string | null;
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  status?: LaunchedTokenStatus;
  launchUrl?: string | null;
  gmgnUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type LaunchedTokenUpdate = Partial<
  Pick<
    LaunchedToken,
    | "tokenAddress"
    | "vaultAddress"
    | "launchTxHash"
    | "status"
    | "launchUrl"
    | "gmgnUrl"
    | "metadata"
  >
>;
