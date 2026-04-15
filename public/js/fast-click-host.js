const fastClickHostShell = document.querySelector("[data-fast-click-host]");
const fastClickHostDataScript = document.querySelector("[data-fast-click-host-data]");

if (fastClickHostShell && fastClickHostDataScript) {
  const stateUrl = fastClickHostShell.dataset.stateUrl || "";
  const startUrl = fastClickHostShell.dataset.startUrl || "";
  const endUrl = fastClickHostShell.dataset.endUrl || "";
  const STATE_POLL_INTERVAL_MS = 15000;
  const PHASE_SYNC_INTERVAL_MS = 150;
  let liveSnapshot = {};
  let actionPending = false;
  let boundarySyncKey = "";
  let serverClockOffsetMs = 0;
  let realtimeSubscription = null;
  let realtimeSessionId = null;

  const hostIcons = {
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>',
    link:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.22"></path><path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 1 0 7.07 7.07L13.3 18.8"></path></svg>',
    screen:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path></svg>',
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>'
  };

  try {
    liveSnapshot = JSON.parse(fastClickHostDataScript.textContent || "{}");
  } catch (error) {
    liveSnapshot = {};
  }

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const syncServerClock = (snapshot) => {
    const serverNowMs = snapshot?.serverNow ? new Date(snapshot.serverNow).getTime() : 0;

    if (serverNowMs) {
      serverClockOffsetMs = serverNowMs - Date.now();
    }
  };

  const getNowMs = () => Date.now() + serverClockOffsetMs;

  const formatCountdownLabel = (deadlineAt) => {
    if (!deadlineAt) {
      return "--";
    }

    const diffMs = new Date(deadlineAt).getTime() - getNowMs();
    return `${Math.max(0, Math.ceil(diffMs / 1000))}s`;
  };

  const formatCountdownNumber = (deadlineAt) => {
    if (!deadlineAt) {
      return "0";
    }

    const diffMs = new Date(deadlineAt).getTime() - getNowMs();
    return String(Math.max(0, Math.ceil(diffMs / 1000)));
  };

  const getBoundaryKey = (snapshot) =>
    `${snapshot.status || ""}:${snapshot.phaseEndsAt || ""}:${snapshot.greenStartsAt || ""}`;

  const renderIcon = (iconName) => hostIcons[iconName] || hostIcons.spark;

  const renderChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="fast-click-chip ${extraClass}">
      <span class="fast-click-chip-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="fast-click-chip-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;

  const renderPlayerCloud = (snapshot) => {
    if (!snapshot.participants?.length) {
      return '<p class="fast-click-empty-note">No players joined yet. Open presenter mode and share the room code to fill the lobby.</p>';
    }

    return `
      <div class="fast-click-lobby-cloud">
        ${snapshot.participants
          .slice(0, 24)
          .map(
            (participant) => `
              <span class="fast-click-lobby-pill">${escapeHtml(participant.displayName)}</span>
            `
          )
          .join("")}
      </div>
    `;
  };

  const renderLeaderboard = (snapshot) => {
    if (!snapshot.leaderboard?.length) {
      return '<p class="fast-click-empty-note">Ranking will appear as soon as the first player clicks on green.</p>';
    }

    return `
      <div class="fast-click-rank-list">
        ${snapshot.leaderboard
          .slice(0, 10)
          .map(
            (entry) => `
              <article class="fast-click-rank-row is-light ${entry.rank === 1 ? "is-active" : ""}">
                <span class="fast-click-rank-number">${entry.rank}</span>
                <div class="fast-click-rank-copy">
                  <strong>${escapeHtml(entry.displayName)}</strong>
                  <span>${escapeHtml(entry.rank === 1 ? "Fastest so far" : "Reaction locked")}</span>
                </div>
                <strong>${escapeHtml(entry.reactionTimeLabel)}</strong>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  };

  const renderActionRow = (snapshot) => {
    const presentUrl = snapshot.room?.presentUrl || "#";

    if (snapshot.status === "finished") {
      return `
        <div class="fast-click-host-actions">
          <a href="${escapeHtml(presentUrl)}" class="secondary-button" target="_blank" rel="noreferrer">Presenter Screen</a>
          <a href="/fast-click" class="primary-button">Create Another Room</a>
        </div>
      `;
    }

    return `
      <div class="fast-click-host-actions">
        <a href="${escapeHtml(presentUrl)}" class="secondary-button" target="_blank" rel="noreferrer">Presenter Screen</a>
        <button type="button" class="primary-button" data-fast-click-start ${snapshot.status === "lobby" && !actionPending ? "" : "disabled"}>
          Start Round
        </button>
        <button type="button" class="secondary-button" data-fast-click-end ${snapshot.status !== "finished" && !actionPending ? "" : "disabled"}>
          End Room
        </button>
      </div>
    `;
  };

  const renderHeaderCard = (snapshot) => {
    const statusLabel =
      snapshot.status === "lobby"
        ? "Lobby Open"
        : snapshot.status === "countdown"
          ? "Countdown"
          : snapshot.status === "red"
            ? "Wait For Green"
            : snapshot.status === "green"
              ? "Tap Window Live"
              : "Round Finished";
    const timingValue =
      snapshot.status === "countdown" || snapshot.status === "red"
        ? formatCountdownLabel(snapshot.phaseEndsAt)
        : snapshot.status === "green"
          ? `${snapshot.remainingCount || 0} left`
          : `${snapshot.clickedCount || 0} recorded`;

    return `
      <article class="fast-click-host-card">
        <div class="fast-click-host-head">
          <div class="fast-click-host-copy-block">
            <span class="section-pill">Fast Click Host</span>
            <h2>${escapeHtml(snapshot.room?.title || "Fast Click")}</h2>
            <p>Run the reaction-speed round from one screen and watch the ranking update live.</p>
          </div>
          ${renderActionRow(snapshot)}
        </div>

        <div class="fast-click-host-chip-row">
          ${renderChip("spark", "Status", statusLabel)}
          ${renderChip("users", "Players", String(snapshot.participantCount || 0))}
          ${renderChip("pulse", "Clicked", String(snapshot.clickedCount || 0))}
          ${renderChip(
            snapshot.status === "green" ? "pulse" : "clock",
            snapshot.status === "finished" ? "Results" : "Timer",
            timingValue,
            snapshot.status === "countdown" || snapshot.status === "red" ? "is-countdown" : "",
            snapshot.status === "countdown" || snapshot.status === "red"
              ? 'data-fast-click-countdown-small=""'
              : ""
          )}
        </div>
      </article>
    `;
  };

  const renderLobbyStage = (snapshot) => {
    const joinLink = snapshot.room?.joinUrl
      ? `${window.location.origin}${snapshot.room.joinUrl}`
      : "";
    const presentLink = snapshot.room?.presentUrl
      ? `${window.location.origin}${snapshot.room.presentUrl}`
      : "";

    return `
      <section class="fast-click-host-stage">
        ${renderHeaderCard(snapshot)}

        <div class="fast-click-stage-grid">
          <article class="fast-click-host-card fast-click-share-card">
            <div class="fast-click-stage-copy">
              <span class="section-pill">Share The Room</span>
              <h2>${escapeHtml(snapshot.room?.roomCode || "")}</h2>
              <p>Keep the room in the lobby until everyone is ready, then launch the countdown.</p>
            </div>

            <div class="fast-click-inline-facts">
              <article class="fast-click-inline-fact">
                <span class="fast-click-inline-fact-icon" aria-hidden="true">${renderIcon("link")}</span>
                <div class="fast-click-inline-fact-copy">
                  <strong>Join link</strong>
                  <span>${escapeHtml(joinLink)}</span>
                </div>
              </article>

              <article class="fast-click-inline-fact">
                <span class="fast-click-inline-fact-icon" aria-hidden="true">${renderIcon("screen")}</span>
                <div class="fast-click-inline-fact-copy">
                  <strong>Presenter screen</strong>
                  <span>${escapeHtml(presentLink)}</span>
                </div>
              </article>
            </div>
          </article>

          <article class="fast-click-host-card">
            <div class="fast-click-stage-copy">
              <span class="section-pill">Players Joined</span>
              <h2>${escapeHtml(String(snapshot.participantCount || 0))}</h2>
              <p>Everyone who is ready will wait here before the signal starts.</p>
            </div>
            ${renderPlayerCloud(snapshot)}
          </article>
        </div>
      </section>
    `;
  };

  const renderSignalCard = (snapshot) => {
    const isCountdown = snapshot.status === "countdown";
    const isRed = snapshot.status === "red";
    const title = isCountdown ? "Countdown to red" : isRed ? "Hold steady" : "Green is live";
    const helper = isCountdown
      ? "Players see the final countdown before the reaction signal starts."
      : isRed
        ? "Nobody should tap yet. The first valid click starts when the signal turns green."
        : "Players can tap now. Ranking updates as each reaction arrives.";

    return `
      <article class="fast-click-host-card">
        <div class="fast-click-stage-copy">
          <span class="section-pill">Signal</span>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(helper)}</p>
        </div>

        <div class="fast-click-signal-wrap">
          ${
            isCountdown
              ? `<div class="fast-click-countdown-number" data-fast-click-countdown-big>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>`
              : `<div class="fast-click-signal-light ${isRed ? "is-red" : "is-green"}"></div>`
          }
        </div>
      </article>
    `;
  };

  const renderResultsCard = (snapshot) => {
    const winner = snapshot.leaderboard?.[0] || null;

    return `
      <article class="fast-click-host-card">
        <div class="fast-click-results-board">
          <div class="fast-click-result-highlight">
            <span class="section-pill">Fastest Click</span>
            <h2>${escapeHtml(winner?.displayName || "Waiting for a winner")}</h2>
            <div class="fast-click-result-time">${escapeHtml(winner?.reactionTimeLabel || "--")}</div>
            <p>${escapeHtml(`${snapshot.clickedCount || 0} of ${snapshot.participantCount || 0} players recorded a time.`)}</p>
          </div>
        </div>
      </article>
    `;
  };

  const renderRuntimeStage = (snapshot) => `
    <section class="fast-click-host-stage">
      ${renderHeaderCard(snapshot)}
      <div class="fast-click-stage-grid">
        ${
          snapshot.status === "finished"
            ? renderResultsCard(snapshot)
            : renderSignalCard(snapshot)
        }
        <article class="fast-click-host-card">
          <div class="fast-click-stage-copy">
            <span class="section-pill">Top 10</span>
            <h2>Reaction ranking</h2>
            <p>Ranking is ordered by the fastest valid click from best to slowest.</p>
          </div>
          ${renderLeaderboard(snapshot)}
        </article>
      </div>
    </section>
  `;

  const render = (snapshot) => {
    liveSnapshot = snapshot || {};
    syncServerClock(liveSnapshot);
    ensureRealtimeSubscription(liveSnapshot.sessionId).catch(() => {});

    fastClickHostShell.innerHTML =
      liveSnapshot.status === "lobby"
        ? renderLobbyStage(liveSnapshot)
        : renderRuntimeStage(liveSnapshot);
  };

  const ensureRealtimeSubscription = async (sessionId) => {
    const nextSessionId = Number.parseInt(String(sessionId || ""), 10);

    if (
      !Number.isInteger(nextSessionId) ||
      nextSessionId <= 0 ||
      realtimeSessionId === nextSessionId ||
      typeof window.createQuizLiveRealtimeSubscription !== "function"
    ) {
      return;
    }

    await Promise.resolve(realtimeSubscription?.unsubscribe?.()).catch(() => {});
    realtimeSessionId = nextSessionId;
    realtimeSubscription = await window.createQuizLiveRealtimeSubscription({
      sessionId: nextSessionId,
      channelName: window.getQuizLiveRealtimeConfig(nextSessionId)?.channelName,
      onSnapshot: (snapshot) => {
        boundarySyncKey = "";
        render(snapshot || {});
      }
    });
  };

  const loadState = async () => {
    if (!stateUrl) {
      return;
    }

    const response = await fetch(stateUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("Unable to refresh the fast click room.");
    }

    const payload = await response.json();

    if (payload.snapshot) {
      boundarySyncKey = "";
      render(payload.snapshot);
    }
  };

  const postAction = async (url) => {
    if (!url || actionPending) {
      return;
    }

    actionPending = true;
    render(liveSnapshot);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json"
        }
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to update the fast click room.");
      }

      boundarySyncKey = "";
      render(payload.snapshot || liveSnapshot);
    } catch (error) {
      window.alert(error.message);
    } finally {
      actionPending = false;
      render(liveSnapshot);
    }
  };

  fastClickHostShell.addEventListener("click", (event) => {
    if (event.target.closest("[data-fast-click-start]")) {
      postAction(startUrl);
      return;
    }

    if (event.target.closest("[data-fast-click-end]")) {
      const shouldEnd = window.confirm("End this fast click room for everyone?");

      if (shouldEnd) {
        postAction(endUrl);
      }
    }
  });

  render(liveSnapshot);

  window.setInterval(() => {
    loadState().catch(() => {});
  }, STATE_POLL_INTERVAL_MS);

  window.setInterval(() => {
    fastClickHostShell.querySelectorAll("[data-fast-click-countdown-small]").forEach((node) => {
      node.textContent = formatCountdownLabel(liveSnapshot.phaseEndsAt);
    });

    fastClickHostShell.querySelectorAll("[data-fast-click-countdown-big]").forEach((node) => {
      node.textContent = formatCountdownNumber(liveSnapshot.phaseEndsAt);
    });

    if (liveSnapshot.phaseEndsAt) {
      const phaseDeadline = new Date(liveSnapshot.phaseEndsAt).getTime();
      const currentBoundaryKey = getBoundaryKey(liveSnapshot);

      if (getNowMs() >= phaseDeadline && currentBoundaryKey && boundarySyncKey !== currentBoundaryKey) {
        boundarySyncKey = currentBoundaryKey;
        loadState().catch(() => {});
      }
    }
  }, PHASE_SYNC_INTERVAL_MS);

  window.addEventListener("beforeunload", () => {
    Promise.resolve(realtimeSubscription?.unsubscribe?.()).catch(() => {});
  });
}
