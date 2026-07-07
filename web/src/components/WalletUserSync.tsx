import { useEffect } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { claimChat, clearLocalAnonymousChats, connectUser, localAnonymousChatIds } from "../lib/chat-api";
import { getCachedUserForWallet, setCurrentUser } from "../lib/current-user";

/**
 * Renders nothing; keeps the chat-history user in sync with the wallet.
 *
 * On connect: if this browser already holds a session token for the wallet,
 * it is reused (no signature prompt — the server checks token expiry on every
 * request). Otherwise the sign-in flow runs: fetch nonce → wallet signs a
 * plain message (no gas) → server verifies and returns a session token that
 * proves wallet ownership on all subsequent API calls. Then any chats this
 * browser started anonymously are claimed into the wallet's history.
 *
 * On disconnect the current user is cleared — chats made while connected
 * stay owned by it.
 */
export default function WalletUserSync() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    if (!isConnected || !address) {
      setCurrentUser(null);
      return;
    }

    let cancelled = false;

    const cached = getCachedUserForWallet(address);
    if (cached?.sessionToken) {
      // Reuse the cached session; if it has expired the next API call fails
      // with 401 and the user can reconnect to sign again.
      setCurrentUser({
        id: cached.id,
        walletAddress: cached.walletAddress,
        sessionToken: cached.sessionToken,
        createdAt: "",
        updatedAt: "",
        lastSeenAt: "",
      });
      void claimAnonymousChats(() => cancelled);
      return () => {
        cancelled = true;
      };
    }

    void connectUser(address, (message) => signMessageAsync({ message }))
      .then(async (user) => {
        if (cancelled) return;
        setCurrentUser(user);
        await claimAnonymousChats(() => cancelled, user);
      })
      .catch(() => {
        // Signature declined or server unreachable — stay signed out; chats
        // fall back to this browser's anonymous ones.
        if (!cancelled) setCurrentUser(null);
      });

    return () => {
      cancelled = true;
    };
  }, [address, isConnected, signMessageAsync]);

  return null;
}

async function claimAnonymousChats(
  isCancelled: () => boolean,
  user?: Parameters<typeof setCurrentUser>[0]
): Promise<void> {
  const anonIds = localAnonymousChatIds();
  if (anonIds.length === 0) return;
  await Promise.allSettled(anonIds.map((id) => claimChat(id)));
  if (isCancelled()) return;
  clearLocalAnonymousChats();
  // Re-notify subscribers (e.g. the chat sidebar) so the newly claimed chats
  // show up without requiring a manual refresh.
  if (user) setCurrentUser(user);
}
