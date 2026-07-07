import { useState } from "react";
import ChatPage from "./ChatPage";
import ChatsLandingPage from "./ChatsLandingPage";
import CodegenStudio from "./CodegenStudio";
import DocsPage from "./DocsPage";
import TokenDetailPage from "./TokenDetailPage";
import TokensPage from "./TokensPage";
import SiteHeader from "./components/SiteHeader";
import {
  matchChatRoute,
  matchChatsRoute,
  matchDocsRoute,
  matchTokenRoute,
  matchTokensRoute,
  navigate,
  usePathname,
} from "./lib/router";
import { cn } from "./lib/utils";

export default function App() {
  const [wideLayout, setWideLayout] = useState(false);
  const pathname = usePathname();

  const chatRoute = matchChatRoute(pathname);
  if (chatRoute) {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <ChatPage key={chatRoute.chatId} chatId={chatRoute.chatId} />
      </div>
    );
  }

  if (matchChatsRoute(pathname)) {
    return <ChatsLandingPage />;
  }

  const tokenRoute = matchTokenRoute(pathname);
  if (tokenRoute) {
    return <TokenDetailPage key={tokenRoute.id} tokenId={tokenRoute.id} />;
  }

  if (matchTokensRoute(pathname)) {
    return <TokensPage />;
  }

  if (matchDocsRoute(pathname)) {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <DocsPage onBack={() => navigate("/")} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className={cn(wideLayout && "container max-w-7xl px-4 py-8 pt-[calc(3.5rem+1rem)] sm:px-6 lg:px-8")}>
        <CodegenStudio onChatActive={setWideLayout} heroLayout={!wideLayout} />
      </main>
    </div>
  );
}
