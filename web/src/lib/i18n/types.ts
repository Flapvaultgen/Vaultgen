/** Shared shape for every language dictionary — add a key here, then fill it in both en.ts and zh.ts. */
export interface Dictionary {
  common: {
    appName: string;
    nav: {
      home: string;
      tokens: string;
      chats: string;
      docs: string;
    };
    langToggleAria: string;
    backToStudio: string;
    loading: string;
  };

  wallet: {
    connecting: string;
    connectMetaMask: string;
    installMetaMask: string;
    providerNotFoundError: string;
    network: string;
    disconnect: string;
  };

  hero: {
    headlineLine1: string;
    headlineLine2: string;
    withWord: string;
    accentWord: string;
    subtitle: string;
    walletNotice: string;
    placeholderConnected: string;
    placeholderDisconnected: string;
    comingSoonNotice: string;
    comingSoonPlaceholder: string;
    examplesLabel: string;
    generate: string;
    generating: string;
    comingSoon: string;
    trustLine: string;
    examples: string[];
  };

  tokensPage: {
    title: string;
    subtitle: string;
    memoryWarning: string;
    loading: string;
    emptyNoWallet: string;
    emptyWithWallet: string;
    noTokenAddress: string;
    vaultPrefix: string;
    status: {
      live: string;
      failed: string;
      launching: string;
      registered: string;
      pending: string;
    };
  };

  tokenDetailPage: {
    backToTokens: string;
    backToAllTokens: string;
    loading: string;
    loadError: string;
    notAvailableYet: string;
    copyAddress: string;
    bnbRaised: string;
    unableToLoad: string;
    loadingShort: string;
    bnbRaisedLiveNote: string;
    bnbRaisedNotLaunched: string;
    buyTax: string;
    sellTax: string;
    tokenContract: string;
    vaultContract: string;
    viewOnFlap: string;
    flapTaxPage: string;
    vaultInformation: string;
    customUiTab: string;
    standardPanelTab: string;
    developerFiles: string;
    developerFilesTitle: string;
    customUiNote: string;
    standardUiNote: string;
    about: string;
    website: string;
    twitter: string;
    telegram: string;
    technicalDetails: string;
    launchTransaction: string;
    registrationTransaction: string;
    launchedByWallet: string;
    factoryContract: string;
    flapPortalContract: string;
    routingNote: string;
  };

  chatPage: {
    newVault: string;
    memoryWarning: string;
    untitled: string;
    noPreviousChats: string;
    loadingChat: string;
    walletNotice: string;
    composerPlaceholderStreaming: string;
    composerPlaceholderIdle: string;
    outputLabel: string;
    backToStudio: string;
  };

  chatsLandingPage: {
    loading: string;
    emptyTitle: string;
    emptyBodyConnected: string;
    emptyBodyDisconnected: string;
    startVault: string;
  };

  launchPanel: {
    walletNotice: string;
  };

  studio: {
    scopeVerdicts: {
      launch_ready_possible: string;
      draft_only: string;
      needs_custom_ui: string;
      needs_protocol_extension: string;
      unsafe_or_unsupported: string;
    };
    notDeliveredAsRequested: string;
    requiredToLaunch: string;
    next: string;
    approximatedDraftTitle: string;
    preserved: string;
    dropped: string;
    toBuildAsRequested: string;
    draftSpecTitle: string;
    notGeneratedTitle: string;
  };

  docsPage: {
    backToStudio: string;
    noCodingRequired: string;
    tocTitle: string;
    toc: {
      overview: string;
      pipeline: string;
      scope: string;
      customUi: string;
      create: string;
      prompts: string;
      lottery: string;
      checks: string;
      deploy: string;
    };
    eyebrow: string;
    title: string;
    intro: string;
    walletNote: string;
    languageNote: string;

    diagram: {
      architectureCaption: string;
      you: string;
      yourWords: string;
      studioLabel: string;
      studioName: string;
      studioPlansIt: string;
      studioBuildsFixes: string;
      safetyLabel: string;
      safetyChecksTests: string;
      safetyFairPayout: string;
      safetyFlapRules: string;
      chainLabel: string;
      chainYourToken: string;
      chainDeployed: string;
      chainCompatible: string;
      chainTestFirst: string;
      onFlapLabel: string;
      onFlapLaunch: string;
      onFlapFees: string;
      onFlapScreen: string;
      pipelineCaption: string;
      pipelineSteps: { title: string; note: string }[];
    };

    overview: {
      eyebrow: string;
      title: string;
      p1: string;
      p2Strong: string;
      p2: string;
      p3: string;
    };

    pipeline: {
      eyebrow: string;
      title: string;
      intro: string;
      steps: { title: string; body: string }[];
    };

    scope: {
      eyebrow: string;
      title: string;
      intro: string;
      cards: { title: string; body: string }[];
      outro: string;
    };

    customUi: {
      eyebrow: string;
      title: string;
      intro: string;
      standardTitle: string;
      standardBody: string;
      bespokeTitle: string;
      bespokeBody: string;
      workbenchTitle: string;
      workbenchBody: string;
    };

    create: {
      eyebrow: string;
      title: string;
      step1Title: string;
      step1Body: string;
      examplesLabel: string;
      examples: string[];
      step2Title: string;
      table: {
        colWhatYouSee: string;
        colWhatItMeans: string;
        rows: { label: string; meaning: string }[];
      };
      step3Title: string;
      step3Body: string;
    };

    prompts: {
      eyebrow: string;
      title: string;
      doTitle: string;
      doItems: string[];
      avoidTitle: string;
      avoidItems: string[];
    };

    lottery: {
      eyebrow: string;
      title: string;
      intro: string;
      items: string[];
      outro: string;
    };

    checks: {
      eyebrow: string;
      title: string;
      intro: string;
      items: string[];
      rulesTitle: string;
      rulesTable: {
        colRule: string;
        colWhatItChecks: string;
        rows: [string, string][];
      };
    };

    deploy: {
      eyebrow: string;
      title: string;
      readyStrong: string;
      readyBody: string;
      beforeYouLaunch: string;
      steps: string[];
      metadataTitle: string;
      metadataBody: string;
      galleryTitle: string;
      galleryBody: string;
      outro: string;
    };
  };
}

export type Lang = "en" | "zh";
