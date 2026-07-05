/**
 * Chat persistence layer.
 *
 * Two implementations behind one interface:
 *  - SupabaseChatStore  — used when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *    are configured (rows live in the tables from supabase/schema.sql).
 *  - MemoryChatStore    — local-dev fallback so the app never crashes when
 *    Supabase env is missing. Data is lost on server restart.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase.js";
import type {
  Chat,
  ChatMessage,
  ChatMessageUpdate,
  ChatUpdate,
  GeneratedArtifact,
  GenerationEvent,
  GenerationRun,
  GenerationRunUpdate,
  NewChat,
  NewChatMessage,
  NewGeneratedArtifact,
  NewGenerationEvent,
  NewGenerationRun,
  NewLaunchedToken,
  NewRepairAttemptRow,
  LaunchedToken,
  LaunchedTokenUpdate,
  RepairAttemptRow,
  User,
} from "./chat-types.js";

export interface ChatStore {
  readonly kind: "supabase" | "memory";

  /** Find-or-create a user by wallet address (lowercased); bumps last_seen_at. */
  upsertUserByWallet(walletAddress: string): Promise<User>;
  getUser(userId: string): Promise<User | null>;

  createChat(input: NewChat): Promise<Chat>;
  listChats(opts?: { includeArchived?: boolean; limit?: number; userId?: string }): Promise<Chat[]>;
  getChat(chatId: string): Promise<Chat | null>;
  updateChat(chatId: string, update: ChatUpdate): Promise<Chat | null>;

  createMessage(input: NewChatMessage): Promise<ChatMessage>;
  updateMessage(messageId: string, update: ChatMessageUpdate): Promise<ChatMessage | null>;
  listMessages(chatId: string): Promise<ChatMessage[]>;

  createRun(input: NewGenerationRun): Promise<GenerationRun>;
  updateRun(runId: string, update: GenerationRunUpdate): Promise<GenerationRun | null>;
  getRun(runId: string): Promise<GenerationRun | null>;
  listRuns(chatId: string): Promise<GenerationRun[]>;

  appendEvent(input: NewGenerationEvent): Promise<GenerationEvent>;
  listEvents(runId: string): Promise<GenerationEvent[]>;

  createArtifact(input: NewGeneratedArtifact): Promise<GeneratedArtifact>;
  listArtifacts(opts: { chatId?: string; runId?: string }): Promise<GeneratedArtifact[]>;

  createRepairAttempt(input: NewRepairAttemptRow): Promise<RepairAttemptRow>;
  listRepairAttempts(runId: string): Promise<RepairAttemptRow[]>;

  createLaunchedToken(input: NewLaunchedToken): Promise<LaunchedToken>;
  updateLaunchedToken(id: string, update: LaunchedTokenUpdate): Promise<LaunchedToken | null>;
  getLaunchedToken(id: string): Promise<LaunchedToken | null>;
  listLaunchedTokens(opts?: {
    walletAddress?: string;
    chainId?: number;
    chatId?: string;
    limit?: number;
  }): Promise<LaunchedToken[]>;
}

// ── In-memory store (dev fallback) ──────────────────────────────────────────

export class MemoryChatStore implements ChatStore {
  readonly kind = "memory" as const;

  private users = new Map<string, User>();
  private chats = new Map<string, Chat>();
  private messages = new Map<string, ChatMessage>();
  private runs = new Map<string, GenerationRun>();
  private events: GenerationEvent[] = [];
  private artifacts: GeneratedArtifact[] = [];
  private repairs: RepairAttemptRow[] = [];
  private launchedTokens: LaunchedToken[] = [];

  async upsertUserByWallet(walletAddress: string): Promise<User> {
    const wallet = walletAddress.toLowerCase();
    const now = new Date().toISOString();
    for (const user of this.users.values()) {
      if (user.walletAddress === wallet) {
        const next: User = { ...user, lastSeenAt: now, updatedAt: now };
        this.users.set(user.id, next);
        return next;
      }
    }
    const user: User = {
      id: randomUUID(),
      walletAddress: wallet,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.get(userId) ?? null;
  }

  async createChat(input: NewChat): Promise<Chat> {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(),
      userId: input.userId ?? null,
      title: input.title?.trim() || "New vault chat",
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      archivedAt: null,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  async listChats(opts?: { includeArchived?: boolean; limit?: number; userId?: string }): Promise<Chat[]> {
    const all = [...this.chats.values()]
      .filter((c) => (opts?.includeArchived ? true : c.status !== "archived"))
      .filter((c) => (opts?.userId ? c.userId === opts.userId : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return all.slice(0, opts?.limit ?? 100);
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return this.chats.get(chatId) ?? null;
  }

  async updateChat(chatId: string, update: ChatUpdate): Promise<Chat | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const next: Chat = { ...chat, ...update, updatedAt: new Date().toISOString() };
    this.chats.set(chatId, next);
    return next;
  }

  async createMessage(input: NewChatMessage): Promise<ChatMessage> {
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      chatId: input.chatId,
      role: input.role,
      content: input.content ?? "",
      status: input.status ?? "completed",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.messages.set(message.id, message);
    await this.updateChat(input.chatId, { lastMessageAt: now });
    return message;
  }

  async updateMessage(messageId: string, update: ChatMessageUpdate): Promise<ChatMessage | null> {
    const message = this.messages.get(messageId);
    if (!message) return null;
    const next: ChatMessage = { ...message, ...update, updatedAt: new Date().toISOString() };
    this.messages.set(messageId, next);
    return next;
  }

  async listMessages(chatId: string): Promise<ChatMessage[]> {
    return [...this.messages.values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createRun(input: NewGenerationRun): Promise<GenerationRun> {
    const now = new Date().toISOString();
    const run: GenerationRun = {
      id: randomUUID(),
      chatId: input.chatId,
      userMessageId: input.userMessageId ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      model: input.model ?? null,
      status: "pending",
      deliverable: null,
      scope: null,
      mechanicSpec: null,
      simulationReport: null,
      economicCritique: null,
      approximationReport: null,
      repairAttempts: null,
      error: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(runId: string, update: GenerationRunUpdate): Promise<GenerationRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const next: GenerationRun = { ...run, ...update, updatedAt: new Date().toISOString() };
    this.runs.set(runId, next);
    return next;
  }

  async getRun(runId: string): Promise<GenerationRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(chatId: string): Promise<GenerationRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendEvent(input: NewGenerationEvent): Promise<GenerationEvent> {
    const event: GenerationEvent = {
      id: randomUUID(),
      runId: input.runId,
      chatId: input.chatId,
      eventType: input.eventType,
      sequence: input.sequence,
      message: input.message ?? null,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(runId: string): Promise<GenerationEvent[]> {
    return this.events.filter((e) => e.runId === runId).sort((a, b) => a.sequence - b.sequence);
  }

  async createArtifact(input: NewGeneratedArtifact): Promise<GeneratedArtifact> {
    const now = new Date().toISOString();
    const artifact: GeneratedArtifact = {
      id: randomUUID(),
      chatId: input.chatId,
      runId: input.runId,
      artifactType: input.artifactType,
      name: input.name,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async listArtifacts(opts: { chatId?: string; runId?: string }): Promise<GeneratedArtifact[]> {
    return this.artifacts
      .filter((a) => (opts.chatId ? a.chatId === opts.chatId : true))
      .filter((a) => (opts.runId ? a.runId === opts.runId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createRepairAttempt(input: NewRepairAttemptRow): Promise<RepairAttemptRow> {
    const row: RepairAttemptRow = {
      id: randomUUID(),
      runId: input.runId,
      attemptNumber: input.attemptNumber,
      reason: input.reason,
      model: input.model ?? null,
      findingsAddressed: input.findingsAddressed ?? [],
      compilePassed: input.compilePassed ?? null,
      scannersPassed: input.scannersPassed ?? null,
      testsPassed: input.testsPassed ?? null,
      criticReran: input.criticReran ?? null,
      remainingIssues: input.remainingIssues ?? [],
      createdAt: new Date().toISOString(),
    };
    this.repairs.push(row);
    return row;
  }

  async listRepairAttempts(runId: string): Promise<RepairAttemptRow[]> {
    return this.repairs
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async createLaunchedToken(input: NewLaunchedToken): Promise<LaunchedToken> {
    const now = new Date().toISOString();
    const row: LaunchedToken = {
      id: randomUUID(),
      chatId: input.chatId ?? null,
      runId: input.runId ?? null,
      artifactId: input.artifactId ?? null,
      walletAddress: input.walletAddress.toLowerCase(),
      chainId: input.chainId,
      tokenName: input.tokenName,
      tokenSymbol: input.tokenSymbol,
      tokenAddress: input.tokenAddress ?? null,
      vaultAddress: input.vaultAddress ?? null,
      registeredVaultId: input.registeredVaultId ?? null,
      registeredVaultHash: input.registeredVaultHash ?? null,
      factoryAddress: input.factoryAddress ?? null,
      launchContractAddress: input.launchContractAddress ?? null,
      registerTxHash: input.registerTxHash ?? null,
      launchTxHash: input.launchTxHash ?? null,
      buyTaxBps: input.buyTaxBps ?? null,
      sellTaxBps: input.sellTaxBps ?? null,
      status: input.status ?? "launch_pending",
      launchUrl: input.launchUrl ?? null,
      gmgnUrl: input.gmgnUrl ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.launchedTokens.push(row);
    return row;
  }

  async updateLaunchedToken(id: string, update: LaunchedTokenUpdate): Promise<LaunchedToken | null> {
    const idx = this.launchedTokens.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const next: LaunchedToken = {
      ...this.launchedTokens[idx]!,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.launchedTokens[idx] = next;
    return next;
  }

  async getLaunchedToken(id: string): Promise<LaunchedToken | null> {
    return this.launchedTokens.find((t) => t.id === id) ?? null;
  }

  async listLaunchedTokens(opts?: {
    walletAddress?: string;
    chainId?: number;
    chatId?: string;
    limit?: number;
  }): Promise<LaunchedToken[]> {
    const wallet = opts?.walletAddress?.toLowerCase();
    return this.launchedTokens
      .filter((t) => (wallet ? t.walletAddress === wallet : true))
      .filter((t) => (opts?.chainId !== undefined ? t.chainId === opts.chainId : true))
      .filter((t) => (opts?.chatId ? t.chatId === opts.chatId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts?.limit ?? 100);
  }
}

// ── Supabase store ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function rowToUser(r: Row): User {
  return {
    id: String(r.id),
    walletAddress: String(r.wallet_address),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastSeenAt: String(r.last_seen_at),
  };
}

function rowToChat(r: Row): Chat {
  return {
    id: String(r.id),
    userId: (r.user_id as string | null) ?? null,
    title: String(r.title ?? ""),
    status: (r.status as Chat["status"]) ?? "active",
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastMessageAt: (r.last_message_at as string | null) ?? null,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

function rowToMessage(r: Row): ChatMessage {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    role: r.role as ChatMessage["role"],
    content: String(r.content ?? ""),
    status: (r.status as ChatMessage["status"]) ?? "completed",
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToRun(r: Row): GenerationRun {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    userMessageId: (r.user_message_id as string | null) ?? null,
    assistantMessageId: (r.assistant_message_id as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    status: (r.status as GenerationRun["status"]) ?? "pending",
    deliverable: (r.deliverable as string | null) ?? null,
    scope: r.scope ?? null,
    mechanicSpec: r.mechanic_spec ?? null,
    simulationReport: r.simulation_report ?? null,
    economicCritique: r.economic_critique ?? null,
    approximationReport: r.approximation_report ?? null,
    repairAttempts: r.repair_attempts ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: String(r.started_at),
    completedAt: (r.completed_at as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToEvent(r: Row): GenerationEvent {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    chatId: String(r.chat_id),
    eventType: r.event_type as GenerationEvent["eventType"],
    sequence: Number(r.sequence ?? 0),
    message: (r.message as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

function rowToArtifact(r: Row): GeneratedArtifact {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    runId: String(r.run_id),
    artifactType: r.artifact_type as GeneratedArtifact["artifactType"],
    name: String(r.name ?? ""),
    content: String(r.content ?? ""),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToRepair(r: Row): RepairAttemptRow {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    attemptNumber: Number(r.attempt_number ?? 0),
    reason: String(r.reason ?? ""),
    model: (r.model as string | null) ?? null,
    findingsAddressed: (r.findings_addressed as unknown[]) ?? [],
    compilePassed: (r.compile_passed as boolean | null) ?? null,
    scannersPassed: (r.scanners_passed as boolean | null) ?? null,
    testsPassed: (r.tests_passed as boolean | null) ?? null,
    criticReran: (r.critic_reran as boolean | null) ?? null,
    remainingIssues: (r.remaining_issues as unknown[]) ?? [],
    createdAt: String(r.created_at),
  };
}

function rowToLaunchedToken(r: Row): LaunchedToken {
  return {
    id: String(r.id),
    chatId: (r.chat_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    artifactId: (r.artifact_id as string | null) ?? null,
    walletAddress: String(r.wallet_address),
    chainId: Number(r.chain_id),
    tokenName: String(r.token_name),
    tokenSymbol: String(r.token_symbol),
    tokenAddress: (r.token_address as string | null) ?? null,
    vaultAddress: (r.vault_address as string | null) ?? null,
    registeredVaultId: (r.registered_vault_id as string | null) ?? null,
    registeredVaultHash: (r.registered_vault_hash as string | null) ?? null,
    factoryAddress: (r.factory_address as string | null) ?? null,
    launchContractAddress: (r.launch_contract_address as string | null) ?? null,
    registerTxHash: (r.register_tx_hash as string | null) ?? null,
    launchTxHash: (r.launch_tx_hash as string | null) ?? null,
    buyTaxBps: r.buy_tax_bps === null || r.buy_tax_bps === undefined ? null : Number(r.buy_tax_bps),
    sellTaxBps: r.sell_tax_bps === null || r.sell_tax_bps === undefined ? null : Number(r.sell_tax_bps),
    status: (r.status as LaunchedToken["status"]) ?? "launch_pending",
    launchUrl: (r.launch_url as string | null) ?? null,
    gmgnUrl: (r.gmgn_url as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function fail(operation: string, error: { message: string } | null): never {
  throw new Error(`[chat-store] ${operation} failed: ${error?.message ?? "unknown Supabase error"}`);
}

export class SupabaseChatStore implements ChatStore {
  readonly kind = "supabase" as const;

  constructor(private client: SupabaseClient) {}

  async upsertUserByWallet(walletAddress: string): Promise<User> {
    const wallet = walletAddress.toLowerCase();
    const { data, error } = await this.client
      .from("users")
      .upsert(
        { wallet_address: wallet, last_seen_at: new Date().toISOString() },
        { onConflict: "wallet_address" }
      )
      .select()
      .single();
    if (error || !data) fail("upsertUserByWallet", error);
    return rowToUser(data);
  }

  async getUser(userId: string): Promise<User | null> {
    const { data, error } = await this.client.from("users").select().eq("id", userId).maybeSingle();
    if (error) fail("getUser", error);
    return data ? rowToUser(data) : null;
  }

  async createChat(input: NewChat): Promise<Chat> {
    const { data, error } = await this.client
      .from("chats")
      .insert({ user_id: input.userId ?? null, title: input.title?.trim() || "New vault chat" })
      .select()
      .single();
    if (error || !data) fail("createChat", error);
    return rowToChat(data);
  }

  async listChats(opts?: { includeArchived?: boolean; limit?: number; userId?: string }): Promise<Chat[]> {
    let query = this.client
      .from("chats")
      .select()
      .order("updated_at", { ascending: false })
      .limit(opts?.limit ?? 100);
    if (!opts?.includeArchived) query = query.neq("status", "archived");
    if (opts?.userId) query = query.eq("user_id", opts.userId);
    const { data, error } = await query;
    if (error) fail("listChats", error);
    return (data ?? []).map(rowToChat);
  }

  async getChat(chatId: string): Promise<Chat | null> {
    const { data, error } = await this.client.from("chats").select().eq("id", chatId).maybeSingle();
    if (error) fail("getChat", error);
    return data ? rowToChat(data) : null;
  }

  async updateChat(chatId: string, update: ChatUpdate): Promise<Chat | null> {
    const patch: Row = {};
    if (update.title !== undefined) patch.title = update.title;
    if (update.status !== undefined) patch.status = update.status;
    if (update.lastMessageAt !== undefined) patch.last_message_at = update.lastMessageAt;
    if (update.archivedAt !== undefined) patch.archived_at = update.archivedAt;
    if (update.userId !== undefined) patch.user_id = update.userId;
    const { data, error } = await this.client
      .from("chats")
      .update(patch)
      .eq("id", chatId)
      .select()
      .maybeSingle();
    if (error) fail("updateChat", error);
    return data ? rowToChat(data) : null;
  }

  async createMessage(input: NewChatMessage): Promise<ChatMessage> {
    const { data, error } = await this.client
      .from("chat_messages")
      .insert({
        chat_id: input.chatId,
        role: input.role,
        content: input.content ?? "",
        status: input.status ?? "completed",
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error || !data) fail("createMessage", error);
    await this.updateChat(input.chatId, { lastMessageAt: new Date().toISOString() });
    return rowToMessage(data);
  }

  async updateMessage(messageId: string, update: ChatMessageUpdate): Promise<ChatMessage | null> {
    const patch: Row = {};
    if (update.content !== undefined) patch.content = update.content;
    if (update.status !== undefined) patch.status = update.status;
    if (update.metadata !== undefined) patch.metadata = update.metadata;
    const { data, error } = await this.client
      .from("chat_messages")
      .update(patch)
      .eq("id", messageId)
      .select()
      .maybeSingle();
    if (error) fail("updateMessage", error);
    return data ? rowToMessage(data) : null;
  }

  async listMessages(chatId: string): Promise<ChatMessage[]> {
    const { data, error } = await this.client
      .from("chat_messages")
      .select()
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    if (error) fail("listMessages", error);
    return (data ?? []).map(rowToMessage);
  }

  async createRun(input: NewGenerationRun): Promise<GenerationRun> {
    const { data, error } = await this.client
      .from("generation_runs")
      .insert({
        chat_id: input.chatId,
        user_message_id: input.userMessageId ?? null,
        assistant_message_id: input.assistantMessageId ?? null,
        model: input.model ?? null,
      })
      .select()
      .single();
    if (error || !data) fail("createRun", error);
    return rowToRun(data);
  }

  async updateRun(runId: string, update: GenerationRunUpdate): Promise<GenerationRun | null> {
    const patch: Row = {};
    if (update.status !== undefined) patch.status = update.status;
    if (update.deliverable !== undefined) patch.deliverable = update.deliverable;
    if (update.scope !== undefined) patch.scope = update.scope;
    if (update.mechanicSpec !== undefined) patch.mechanic_spec = update.mechanicSpec;
    if (update.simulationReport !== undefined) patch.simulation_report = update.simulationReport;
    if (update.economicCritique !== undefined) patch.economic_critique = update.economicCritique;
    if (update.approximationReport !== undefined) patch.approximation_report = update.approximationReport;
    if (update.repairAttempts !== undefined) patch.repair_attempts = update.repairAttempts;
    if (update.error !== undefined) patch.error = update.error;
    if (update.completedAt !== undefined) patch.completed_at = update.completedAt;
    const { data, error } = await this.client
      .from("generation_runs")
      .update(patch)
      .eq("id", runId)
      .select()
      .maybeSingle();
    if (error) fail("updateRun", error);
    return data ? rowToRun(data) : null;
  }

  async getRun(runId: string): Promise<GenerationRun | null> {
    const { data, error } = await this.client
      .from("generation_runs")
      .select()
      .eq("id", runId)
      .maybeSingle();
    if (error) fail("getRun", error);
    return data ? rowToRun(data) : null;
  }

  async listRuns(chatId: string): Promise<GenerationRun[]> {
    const { data, error } = await this.client
      .from("generation_runs")
      .select()
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    if (error) fail("listRuns", error);
    return (data ?? []).map(rowToRun);
  }

  async appendEvent(input: NewGenerationEvent): Promise<GenerationEvent> {
    const { data, error } = await this.client
      .from("generation_events")
      .insert({
        run_id: input.runId,
        chat_id: input.chatId,
        event_type: input.eventType,
        sequence: input.sequence,
        message: input.message ?? null,
        payload: input.payload ?? {},
      })
      .select()
      .single();
    if (error || !data) fail("appendEvent", error);
    return rowToEvent(data);
  }

  async listEvents(runId: string): Promise<GenerationEvent[]> {
    const { data, error } = await this.client
      .from("generation_events")
      .select()
      .eq("run_id", runId)
      .order("sequence", { ascending: true });
    if (error) fail("listEvents", error);
    return (data ?? []).map(rowToEvent);
  }

  async createArtifact(input: NewGeneratedArtifact): Promise<GeneratedArtifact> {
    const { data, error } = await this.client
      .from("generated_artifacts")
      .insert({
        chat_id: input.chatId,
        run_id: input.runId,
        artifact_type: input.artifactType,
        name: input.name,
        content: input.content,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error || !data) fail("createArtifact", error);
    return rowToArtifact(data);
  }

  async listArtifacts(opts: { chatId?: string; runId?: string }): Promise<GeneratedArtifact[]> {
    let query = this.client.from("generated_artifacts").select().order("created_at", { ascending: true });
    if (opts.chatId) query = query.eq("chat_id", opts.chatId);
    if (opts.runId) query = query.eq("run_id", opts.runId);
    const { data, error } = await query;
    if (error) fail("listArtifacts", error);
    return (data ?? []).map(rowToArtifact);
  }

  async createRepairAttempt(input: NewRepairAttemptRow): Promise<RepairAttemptRow> {
    const { data, error } = await this.client
      .from("repair_attempts")
      .insert({
        run_id: input.runId,
        attempt_number: input.attemptNumber,
        reason: input.reason,
        model: input.model ?? null,
        findings_addressed: input.findingsAddressed ?? [],
        compile_passed: input.compilePassed ?? null,
        scanners_passed: input.scannersPassed ?? null,
        tests_passed: input.testsPassed ?? null,
        critic_reran: input.criticReran ?? null,
        remaining_issues: input.remainingIssues ?? [],
      })
      .select()
      .single();
    if (error || !data) fail("createRepairAttempt", error);
    return rowToRepair(data);
  }

  async listRepairAttempts(runId: string): Promise<RepairAttemptRow[]> {
    const { data, error } = await this.client
      .from("repair_attempts")
      .select()
      .eq("run_id", runId)
      .order("attempt_number", { ascending: true });
    if (error) fail("listRepairAttempts", error);
    return (data ?? []).map(rowToRepair);
  }

  async createLaunchedToken(input: NewLaunchedToken): Promise<LaunchedToken> {
    const { data, error } = await this.client
      .from("launched_tokens")
      .insert({
        chat_id: input.chatId ?? null,
        run_id: input.runId ?? null,
        artifact_id: input.artifactId ?? null,
        wallet_address: input.walletAddress.toLowerCase(),
        chain_id: input.chainId,
        token_name: input.tokenName,
        token_symbol: input.tokenSymbol,
        token_address: input.tokenAddress ?? null,
        vault_address: input.vaultAddress ?? null,
        registered_vault_id: input.registeredVaultId ?? null,
        registered_vault_hash: input.registeredVaultHash ?? null,
        factory_address: input.factoryAddress ?? null,
        launch_contract_address: input.launchContractAddress ?? null,
        register_tx_hash: input.registerTxHash ?? null,
        launch_tx_hash: input.launchTxHash ?? null,
        buy_tax_bps: input.buyTaxBps ?? null,
        sell_tax_bps: input.sellTaxBps ?? null,
        status: input.status ?? "launch_pending",
        launch_url: input.launchUrl ?? null,
        gmgn_url: input.gmgnUrl ?? null,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error || !data) fail("createLaunchedToken", error);
    return rowToLaunchedToken(data);
  }

  async updateLaunchedToken(id: string, update: LaunchedTokenUpdate): Promise<LaunchedToken | null> {
    const patch: Row = {};
    if (update.tokenAddress !== undefined) patch.token_address = update.tokenAddress;
    if (update.vaultAddress !== undefined) patch.vault_address = update.vaultAddress;
    if (update.launchTxHash !== undefined) patch.launch_tx_hash = update.launchTxHash;
    if (update.status !== undefined) patch.status = update.status;
    if (update.launchUrl !== undefined) patch.launch_url = update.launchUrl;
    if (update.gmgnUrl !== undefined) patch.gmgn_url = update.gmgnUrl;
    if (update.metadata !== undefined) patch.metadata = update.metadata;
    const { data, error } = await this.client
      .from("launched_tokens")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) fail("updateLaunchedToken", error);
    return data ? rowToLaunchedToken(data) : null;
  }

  async getLaunchedToken(id: string): Promise<LaunchedToken | null> {
    const { data, error } = await this.client.from("launched_tokens").select().eq("id", id).maybeSingle();
    if (error) fail("getLaunchedToken", error);
    return data ? rowToLaunchedToken(data) : null;
  }

  async listLaunchedTokens(opts?: {
    walletAddress?: string;
    chainId?: number;
    chatId?: string;
    limit?: number;
  }): Promise<LaunchedToken[]> {
    let query = this.client
      .from("launched_tokens")
      .select()
      .order("created_at", { ascending: false })
      .limit(opts?.limit ?? 100);
    if (opts?.walletAddress) query = query.eq("wallet_address", opts.walletAddress.toLowerCase());
    if (opts?.chainId !== undefined) query = query.eq("chain_id", opts.chainId);
    if (opts?.chatId) query = query.eq("chat_id", opts.chatId);
    const { data, error } = await query;
    if (error) fail("listLaunchedTokens", error);
    return (data ?? []).map(rowToLaunchedToken);
  }
}

// ── store selection ──────────────────────────────────────────────────────────

let activeStore: ChatStore | null = null;

/** Supabase-backed store when configured; in-memory fallback otherwise. */
export function getChatStore(): ChatStore {
  if (activeStore) return activeStore;
  const client = getSupabaseAdmin();
  activeStore = client ? new SupabaseChatStore(client) : new MemoryChatStore();
  return activeStore;
}

/** Test hook: replace or reset the active store. */
export function setChatStoreForTests(store: ChatStore | null): void {
  activeStore = store;
}
