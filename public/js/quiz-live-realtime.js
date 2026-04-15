(function initializeQuizLiveRealtime() {
  const realtimeConfigNode = document.querySelector("[data-quiz-live-realtime-config]");
  let baseRealtimeConfig = {};

  if (realtimeConfigNode) {
    try {
      baseRealtimeConfig = JSON.parse(realtimeConfigNode.textContent || "{}");
    } catch (error) {
      baseRealtimeConfig = {};
    }
  }

  const normalizeSessionId = (value) => {
    const parsedValue = Number.parseInt(String(value || "").trim(), 10);
    return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
  };

  const buildChannelName = (sessionId) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return normalizedSessionId ? `quiz-live:${normalizedSessionId}` : "";
  };

  const getRealtimeConfig = (sessionId = null) => {
    const resolvedSessionId =
      normalizeSessionId(sessionId) || normalizeSessionId(baseRealtimeConfig.sessionId);
    const resolvedChannelName =
      baseRealtimeConfig.channelName || buildChannelName(resolvedSessionId);

    return {
      enabled: Boolean(baseRealtimeConfig.enabled),
      supabaseUrl: String(baseRealtimeConfig.supabaseUrl || "").trim(),
      supabaseAnonKey: String(baseRealtimeConfig.supabaseAnonKey || "").trim(),
      sessionId: resolvedSessionId,
      channelName: resolvedChannelName
    };
  };

  let realtimeClient = null;

  const getRealtimeClient = () => {
    const realtimeConfig = getRealtimeConfig();

    if (
      !realtimeConfig.enabled ||
      !realtimeConfig.supabaseUrl ||
      !realtimeConfig.supabaseAnonKey ||
      !window.supabase?.createClient
    ) {
      return null;
    }

    if (!realtimeClient) {
      realtimeClient = window.supabase.createClient(
        realtimeConfig.supabaseUrl,
        realtimeConfig.supabaseAnonKey,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
          }
        }
      );
    }

    return realtimeClient;
  };

  const createNoopSubscription = async () => ({
    channelName: "",
    status: "CLOSED",
    unsubscribe: async () => {}
  });

  const createQuizLiveRealtimeSubscription = async (options = {}) => {
    const realtimeConfig = getRealtimeConfig(options.sessionId || null);
    const client = getRealtimeClient();

    if (!client || !realtimeConfig.channelName) {
      return createNoopSubscription();
    }

    const channel = client.channel(options.channelName || realtimeConfig.channelName, {
      config: {
        broadcast: {
          self: false
        }
      }
    });

    let currentStatus = "CLOSED";
    let isSettled = false;

    channel.on("broadcast", { event: "snapshot" }, (message) => {
      if (typeof options.onSnapshot === "function" && message?.payload?.snapshot) {
        options.onSnapshot(message.payload.snapshot, message.payload);
      }
    });

    channel.on("broadcast", { event: "progress" }, (message) => {
      if (typeof options.onProgress === "function" && message?.payload?.progress) {
        options.onProgress(message.payload.progress, message.payload);
      }
    });

    const waitForSubscription = new Promise((resolve) => {
      const finalize = () => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        resolve({
          channelName: channel.topic,
          status: currentStatus,
          unsubscribe: async () => {
            try {
              await client.removeChannel(channel);
            } catch (error) {
              // ignore realtime cleanup failures
            }
          }
        });
      };

      channel.subscribe((status) => {
        currentStatus = status;

        if (typeof options.onStatus === "function") {
          options.onStatus(status);
        }

        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          finalize();
        }
      });

      window.setTimeout(finalize, 3000);
    });

    return waitForSubscription;
  };

  window.getQuizLiveRealtimeConfig = getRealtimeConfig;
  window.getQuizLiveRealtimeChannelName = buildChannelName;
  window.createQuizLiveRealtimeSubscription = createQuizLiveRealtimeSubscription;
})();
