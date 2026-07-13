import type { Dictionary } from "./types";

/**
 * English strings. `zh.ts` implements the same `Dictionary` interface, so
 * any key added here must be translated there too (TypeScript enforces it).
 */
export const en: Dictionary = {
  common: {
    appName: "Flap Vault Gen",
    nav: {
      home: "Home",
      tokens: "Tokens",
      chats: "Chats",
      docs: "Docs",
    },
    langToggleAria: "Switch language",
    backToStudio: "Back to studio",
    loading: "Loading…",
  },

  wallet: {
    connecting: "Connecting…",
    connectMetaMask: "Connect MetaMask",
    installMetaMask: "Install MetaMask",
    providerNotFoundError:
      "MetaMask provider not found. Install MetaMask, unlock it, and disable other wallet extensions (Rabby, OKX, etc.) if they override the browser provider.",
    network: "Network",
    disconnect: "Disconnect",
  },

  hero: {
    headlineLine1: "Describe a vault",
    headlineLine2: "mechanic in plain words",
    withWord: "with ",
    accentWord: "Flap Vault Gen.",
    subtitle:
      "Plan → scope → Solidity → compile → safety scan → fork tests → advisory audit. No vault templates — any mechanic that fits Flap Rules 001–009.",
    walletNotice: "Connect your wallet to describe and generate a vault.",
    placeholderConnected:
      "Describe any Flap-compatible vault mechanic — actors, buckets, actions, payouts. Write in English or 中文. The AI plans it, generates Solidity, tests it, and tells you if it's launch-ready or draft-only.",
    placeholderDisconnected: "Connect your wallet above to get started…",
    examplesLabel: "Try an idea",
    generate: "Generate Solidity",
    generating: "Generating…",
    trustLine: "9 Flap safety rules enforced automatically · English & 中文 supported",
    examples: [
      "Holders vote weekly on which charity wallet receives the treasury bucket",
      "Users submit quest proofs, the manager approves valid proofs, and approved users claim from a reward bucket",
      "Referral vault where users set a referrer and the manager settles referral rewards from tax BNB",
      "Epoch vault where tax BNB accumulates for 7 days, then the manager settles rewards pro-rata to registered participants",
      "Milestone vault that unlocks actions when treasury BNB crosses set thresholds",
    ],
  },

  tokensPage: {
    title: "Launched tokens",
    subtitle: "Vault tokens launched through Flap Vault Gen — tax info, explorer links, and live details.",
    memoryWarning:
      "Supabase is not configured yet. Launched token history will appear here after configuration (in-memory records are lost on server restart).",
    loading: "Loading tokens…",
    emptyNoWallet: "No launched tokens yet. Complete register + launch in a vault chat to see them here.",
    emptyWithWallet:
      "No launched tokens yet for your connected wallet. Complete register + launch in a vault chat to see them here.",
    noTokenAddress: "no token address yet",
    vaultPrefix: "vault",
    status: {
      live: "Live",
      failed: "Failed",
      launching: "Launching…",
      registered: "Registered",
      pending: "Pending",
    },
  },

  tokenDetailPage: {
    backToTokens: "Back to tokens",
    backToAllTokens: "Back to all tokens",
    loading: "Loading token…",
    loadError: "Failed to load token.",
    notAvailableYet: "Not available yet",
    copyAddress: "Copy address",
    bnbRaised: "BNB raised",
    unableToLoad: "Unable to load",
    loadingShort: "Loading…",
    bnbRaisedLiveNote: "Every trade's fee lands here — updates live",
    bnbRaisedNotLaunched: "Not launched yet",
    buyTax: "Buy tax",
    sellTax: "Sell tax",
    tokenContract: "Token contract",
    vaultContract: "Vault contract",
    viewOnFlap: "View on Flap",
    flapTaxPage: "Flap tax page",
    vaultInformation: "Vault information",
    customUiTab: "Custom UI",
    standardPanelTab: "Standard panel",
    developerFiles: "Developer files",
    developerFilesTitle: "Download the developer source files for this vault's interface",
    customUiNote:
      "A custom dashboard built for this vault — everything you see is read live from the blockchain, and any button you click asks your wallet to approve a real transaction.",
    standardUiNote: "A general-purpose dashboard, read live from the blockchain — works the same way for any vault.",
    about: "About",
    website: "Website",
    twitter: "X / Twitter",
    telegram: "Telegram",
    technicalDetails: "Technical details",
    launchTransaction: "Launch transaction",
    registrationTransaction: "Registration transaction",
    launchedByWallet: "Launched by (wallet)",
    factoryContract: "Factory contract",
    flapPortalContract: "Flap portal contract",
    routingNote: "100% of trading fees route straight to this vault{name} — no LP, burn, or dividend split.",
  },

  chatPage: {
    newVault: "New vault",
    memoryWarning: "History is in-memory only (Supabase not configured) — chats are lost when the server restarts.",
    untitled: "Untitled",
    noPreviousChats: "No previous chats yet.",
    loadingChat: "Loading…",
    walletNotice: "Connect your wallet to continue this chat.",
    composerPlaceholderStreaming: "Generation in progress…",
    composerPlaceholderIdle: "Describe a change or a new mechanic…",
    outputLabel: "Output",
    backToStudio: "Back to studio",
    progress: {
      connecting: "Connected — getting ready…",
      planning: "Planning your vault…",
      writing: "Writing the contract…",
      rewriting: "Improving the contract (pass {pass})…",
      compiling: "Compiling…",
      fixingCompile: "Fixing compile errors…",
      fixingSafety: "Fixing safety-check findings…",
      improvingCompat: "Improving Flap compatibility…",
      generatingTests: "Testing the vault…",
      fixingTests: "Fixing test failures…",
      simulationDone: "Simulation finished.",
      auditing: "Running the Flap pre-audit…",
      economicReview: "Running the economic review…",
      repairing: "Applying automatic improvements…",
      designingUi: "Designing the vault UI…",
      finalizing: "Finalizing…",
      contractName: "Contract: {name}",
    },
  },

  chatsLandingPage: {
    loading: "Loading your chats…",
    emptyTitle: "No chats yet",
    emptyBodyConnected: "You haven't started a vault chat with this wallet yet. Describe an idea on the home page to start your first one.",
    emptyBodyDisconnected:
      "No chats yet in this browser. Connect your wallet to see chats tied to your wallet, or describe an idea on the home page to start one.",
    startVault: "Describe a vault",
  },

  launchPanel: {
    walletNotice: "Connect your wallet to deploy, register, and launch this vault.",
  },

  studio: {
    scopeVerdicts: {
      launch_ready_possible: "Launch-ready possible",
      draft_only: "Draft only — not launch-ready as requested",
      needs_custom_ui: "Contract can work — standard panel can't render it",
      needs_protocol_extension: "Needs a protocol extension",
      unsafe_or_unsupported: "Unsafe or unsupported",
    },
    notDeliveredAsRequested: "Not delivered as requested:",
    requiredToLaunch: "Required to make it launch-ready:",
    next: "Next:",
    approximatedDraftTitle: "Approximated draft — differences from your request",
    preserved: "Preserved:",
    dropped: "Dropped:",
    toBuildAsRequested: "To build it as requested:",
    draftSpecTitle: "Draft spec (no contract)",
    notGeneratedTitle: "Not generated",
  },

  docsPage: {
    backToStudio: "Back to studio",
    noCodingRequired: "No coding required",
    tocTitle: "On this page",
    toc: {
      overview: "Overview",
      pipeline: "How it works",
      scope: "If your idea can't be built exactly",
      customUi: "Your vault's screen & the Workbench",
      create: "Create a vault",
      prompts: "Writing a good description",
      lottery: "Lotteries & random winners",
      checks: "Automatic safety checks",
      deploy: "Testing vs. going live",
    },
    eyebrow: "Documentation",
    title: "Flap Vault Gen",
    intro:
      "Describe how you want your token's trading fees to be collected and paid out — in plain English or 中文, like you're explaining it to a friend. The studio turns that into a real smart contract, checks it for safety issues, tests it, and lets you launch it on Flap. No coding knowledge needed.",
    walletNote:
      "You can read this page and browse launched tokens without connecting anything. To describe an idea, chat, or launch a token, connect a wallet (MetaMask) first using the button in the top right — that wallet is how the studio knows which chats and tokens are yours.",
    languageNote: "Switch the whole site between English and 中文 anytime with the EN / 中文 buttons in the top right — including the AI itself, which understands and replies in either language.",

    diagram: {
      architectureCaption: "From a plain-language idea to a live token on-chain",
      you: "You",
      yourWords: "Your own words",
      studioLabel: "STUDIO",
      studioName: "Flap Vault Gen",
      studioPlansIt: "Plans it, writes the code",
      studioBuildsFixes: "Builds & fixes automatically",
      safetyLabel: "SAFETY",
      safetyChecksTests: "Checks & tests",
      safetyFairPayout: "Fair-payout review",
      safetyFlapRules: "Flap rules review",
      chainLabel: "BNB CHAIN",
      chainYourToken: "Your token",
      chainDeployed: "Deployed on-chain",
      chainCompatible: "Flap-compatible vault",
      chainTestFirst: "Test network first",
      onFlapLabel: "ON FLAP",
      onFlapLaunch: "Token launch",
      onFlapFees: "Fees → vault",
      onFlapScreen: "Holder screen",
      pipelineCaption: "Every generation goes through the same steps, automatically",
      pipelineSteps: [
        { title: "Plan it", note: "Who's involved, where money goes" },
        { title: "Check feasibility", note: "Can this be built as asked?" },
        { title: "Write the code", note: "Turns the plan into a contract" },
        { title: "Safety checks", note: "Scans for common mistakes" },
        { title: "Test it", note: "Tried on a copy of the real chain" },
        { title: "Ready to launch", note: "Goes live on Flap" },
      ],
    },

    overview: {
      eyebrow: "Start here",
      title: "What this is",
      p1: "Normally, building a custom token reward system means hiring a blockchain developer, learning a programming language, and knowing dozens of small safety rules — the kind of mistakes that have caused real projects to lose real money.",
      p2Strong: "Flap Vault Gen",
      p2:
        "does all of that for you. You describe what you want in normal words, in English or Simplified Chinese. The AI plans it, writes the contract, checks it for safety problems, tests it against a live copy of the blockchain, and tells you honestly whether what you asked for can be built exactly as described — or what the closest safe alternative would be.",
      p3: "There's no fixed list of \"vault types\" to choose from. Describe almost any fee/reward idea and the AI will try to build it.",
    },

    pipeline: {
      eyebrow: "Under the hood",
      title: "What happens after you hit Generate",
      intro: "This isn't a single AI reply pretending to be a smart contract. Every request goes through the same careful, multi-step process:",
      steps: [
        { title: "Plan it", body: "the AI first writes a short internal plan: who's involved, where the fee money goes, what people can click, and how payouts work." },
        { title: "Check feasibility", body: "before writing any code, it decides: can this be built exactly as described? If not, it explains why and offers alternatives instead of quietly building something different than what you asked for." },
        { title: "Write the code", body: "it turns the plan into an actual smart contract, using Flap's official building blocks." },
        { title: "Compile it", body: "the code is built with the same professional tools real blockchain developers use, catching mistakes immediately." },
        { title: "Safety checks", body: "automated scans look for the kind of mistakes that have caused real projects to lose money — like doing risky work in the function that receives trading fees, or letting one person unfairly drain a reward pool meant to be shared." },
        { title: "Fix it automatically", body: "if a check fails, the AI reads exactly what went wrong and tries again — up to several attempts — without you needing to do anything." },
        { title: "Test it for real", body: "a test is written and run against a live copy of the actual blockchain, so the contract is checked under realistic conditions before you ever risk real money." },
        { title: "A second opinion (informational)", body: "two more automated reviews check the contract against Flap's official rules and against fairness/economics. These are shown to you as guidance — they inform you, they don't block you." },
        { title: "Keep refining", body: "once you have a result, just keep describing changes in the chat — in English or 中文. The same process runs again on your existing vault." },
      ],
    },

    scope: {
      eyebrow: "Before any code is written",
      title: "If your idea can't be built exactly as asked",
      intro: "Before writing any code, the studio decides how well your idea fits what's actually possible. If it's anything other than a clean \"yes\", generation pauses until you decide how to proceed:",
      cards: [
        { title: "Yes, as described", body: "Your idea fits within what's possible today. The studio goes ahead and builds it exactly as you asked." },
        { title: "Close, but not exact", body: "It can build something close to your idea, but not every detail. You'll see exactly what's different before deciding whether to continue." },
        { title: "Would need a custom screen", body: "The contract itself would work, but the standard on-site controls can't display everything it needs — it would require a custom-built screen." },
        { title: "Not possible yet", body: "This would require changes to the underlying Flap platform itself — beyond what can be built for you today." },
        { title: "Not safe / not supported", body: "This idea has a fundamental safety problem, or isn't something that can be built safely. The studio won't generate a contract for it." },
      ],
      outro: "If you choose to build the closest safe version of your idea, the studio always tells you plainly what was kept, what was left out, and what it would take to build your original idea exactly.",
    },

    customUi: {
      eyebrow: "Beyond the standard controls",
      title: "Your vault's screen — and Flap's official Workbench",
      intro:
        "The moment your token launches, it gets an interactive screen where anyone can see its state and use its buttons — no design work needed from you. Depending on what your idea needs, that screen is one of two things:",
      standardTitle: "The standard panel (every vault gets this, automatically)",
      standardBody:
        "Every vault contract carries a small built-in description of its own buttons, fields, and countdowns. Our site reads that description straight from the blockchain and draws a working screen from it — this happens automatically for every vault, the instant it launches, with zero extra steps.",
      bespokeTitle: "A custom-built screen (for ideas that need one)",
      bespokeBody:
        "Some mechanics need something the standard panel can't draw on its own — a leaderboard, a countdown ring, a layout themed to your token. For those, the AI can additionally generate a bespoke, hand-designed screen (built the same way Flap's own official vaults present themselves). It works immediately on our site, connected live to your launched vault and your wallet — you'll see a \"Vault UI\" tab in the chat once one is generated.",
      workbenchTitle: "Getting it to show on flap.sh too",
      workbenchBody:
        "That custom screen always works here, on our site, right away — nothing extra to do. To have the same screen also appear when people view your token directly on flap.sh, download the generated package from the \"Vault UI\" tab and submit it through Flap's official Workbench; their team reviews submissions before they go live on their site. Until it's approved there, flap.sh shows its own default view for your token, while our site keeps showing your full custom screen regardless.",
    },

    create: {
      eyebrow: "Quick start",
      title: "Create a vault in three steps",
      step1Title: "1. Describe the idea",
      step1Body: "Use the box on the home page. Say where the trading-fee money should go, what people should be able to do, any timing (daily, weekly, etc.), and whether you want a random winner picked. Write in English or 中文.",
      examplesLabel: "A few examples you can paste and adjust:",
      examples: [
        "Holders who stake their tokens earn a share of the trading fees, based on how much they've staked.",
        "Split trading fees 50/50 between a buyback fund and the team wallet. Only the team can trigger a buyback.",
        "Fees build up a jackpot every week. Holders can enter once per week. A fair random draw picks the winner.",
        "People submit proof they completed a task, an admin approves it, and approved people can then claim a reward.",
      ],
      step2Title: "2. Review the result",
      table: {
        colWhatYouSee: "What you'll see",
        colWhatItMeans: "What it means",
        rows: [
          { label: "Compiled", meaning: "Your code built successfully with real blockchain tools" },
          { label: "Safety", meaning: "pass = no issues found · review = a few things worth a second look · blocked = a real problem was found and must be fixed first" },
          { label: "Scope", meaning: "Whether this matches your request exactly, or is the closest safe version" },
          { label: "Flap review", meaning: "An extra check against Flap's official rules — informational, doesn't block you" },
          { label: "Ready to launch", meaning: "Everything above passed — you're clear to launch it" },
        ],
      },
      step3Title: "3. Keep refining in chat",
      step3Body: "After the first result, you land in a chat. Ask for changes in normal language, in English or 中文 — each message updates the same vault. Click {newVault} to start over with a fresh idea.",
    },

    prompts: {
      eyebrow: "Tips",
      title: "Writing a good description",
      doTitle: "Do this",
      doItems: [
        "Give the fee money named destinations (e.g. \"buyback fund\", \"jackpot\", \"team wallet\")",
        "Say who's allowed to do what — regular holders vs. an admin/manager",
        "Mention \"lottery\", \"random\", or \"last one standing\" if you want a random winner",
        "If a reward is shared between many people, say whether it's split proportionally or \"winner takes all\"",
      ],
      avoidTitle: "Avoid this",
      avoidItems: [
        "Basing rewards on how many tokens someone holds right now — easy to game; ask for staking instead",
        "Wanting a buyback to happen the instant fees arrive — that's not safe; make it a separate action someone triggers",
        "Asking to list every single holder on-chain — gets very expensive with lots of holders; use staking/registration instead",
        "Asking for a \"claim reward\" button without saying where that reward actually comes from",
      ],
    },

    lottery: {
      eyebrow: "Randomness",
      title: "Lotteries, raffles & picking a random winner",
      intro: "If your idea needs a random pick — a lottery, a raffle, choosing a winner — nothing is left to chance in a way that could be gamed. Flap uses its own trusted, verifiable random-result service:",
      items: [
        "Everyone eligible is locked in before the draw happens",
        "An admin/manager starts the draw, paying a small fee (usually from the jackpot itself)",
        "A verified random result comes back a short while later — not instantly",
        "The winner is paid out automatically once the result arrives",
      ],
      outro: "Because the result arrives slightly after the draw is requested, don't expect a winner announced in the same click.",
    },

    checks: {
      eyebrow: "Safety",
      title: "What the studio checks automatically",
      intro: "You don't need to memorize any rules. Behind the scenes, the studio always enforces:",
      items: [
        "The function that receives trading fees only updates internal counters — no risky actions happen there",
        "Payouts come from clearly named pots, never the contract's entire balance",
        "Error messages are shown in both English and Chinese, so Flap's site can display them to anyone",
        "Lotteries cap how many people can enter and reset properly between rounds",
        "Random outcomes always come from Flap's trusted service — never a guessable/manipulable source",
        "Staking rewards use correct, tamper-resistant math",
        "Shared rewards require proper per-person accounting, unless \"winner takes all\" was explicit",
        "No half-finished claim buttons — every \"claim\" must have a real, traceable source of funds",
      ],
      rulesTitle: "Flap's 9 official rules, reviewed on every vault",
      rulesTable: {
        colRule: "Rule",
        colWhatItChecks: "What it checks",
        rows: [
          ["001", "Where fee money goes, and who's allowed to do what"],
          ["002", "Works correctly with Flap's official launch system"],
          ["003", "Fairness — can anyone cheat or unfairly drain shared funds"],
          ["004", "Error messages people can actually understand, in English and Chinese"],
          ["005", "The function receiving trading fees can't be overloaded with risky work"],
          ["006", "Real tests run against a live copy of the blockchain"],
          ["007", "Random outcomes use a trusted, verifiable source — never guessable"],
          ["008", "Support for scheduled/automatic actions, if your idea needs them"],
          ["009", "An emergency pause and withdrawal, in case something goes wrong"],
        ] as [string, string][],
      },
    },

    deploy: {
      eyebrow: "Launch",
      title: "Testing vs. going live for real",
      readyStrong: "Ready to launch",
      readyBody: "means your contract built successfully, passed the automatic safety checks, and passed testing against a live copy of the real blockchain. The extra advisory review is there to help you double-check things yourself — treat anything it flags as a checklist, not a hard blocker.",
      beforeYouLaunch: "Before you launch with real money on the line:",
      steps: [
        "Read through what was built (or have someone you trust take a look)",
        "Try it first on the test network — real trading, but with fake money that costs nothing",
        "Go through the advisory review yourself, item by item",
        "If you expect real trading volume, get an independent security review before going live",
      ],
      metadataTitle: "Adding a picture, description, and links",
      metadataBody:
        "Before you launch, the launch screen lets you add a token image, a short description, and links to your website, X/Twitter, and Telegram — these are stored through Flap's own official metadata service and shown on flap.sh. You can also choose how much BNB you personally buy at launch (optional). None of this can be changed after the token launches, so it's worth double-checking before you confirm.",
      galleryTitle: "Your token's public page",
      galleryBody:
        "Every token launched here also gets its own public page, listed under \"Tokens\" in the top menu — anyone can browse it, see its image, tax rate, and vault screen, with no login or coding knowledge needed. This is separate from your private chat history, which only your connected wallet can see.",
      outro: "When you're ready, launching happens through the same official system Flap uses for every token — right from this site, connected to your own wallet. If you want a more upgradeable setup for a serious, longer-lived project, just mention that when describing your idea.",
    },
  },
};
