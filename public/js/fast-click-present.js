const fastClickPresentShell = document.querySelector("[data-fast-click-present]");
const fastClickPresentDataScript = document.querySelector("[data-fast-click-present-data]");

if (fastClickPresentShell && fastClickPresentDataScript) {
  const stateUrl = fastClickPresentShell.dataset.stateUrl || "";
  const STATE_POLL_INTERVAL_MS = 15000;
  const PHASE_SYNC_INTERVAL_MS = 150;
  let liveSnapshot = {};
  let boundarySyncKey = "";
  let serverClockOffsetMs = 0;
  let realtimeSubscription = null;
  let realtimeSessionId = null;

  const presentIcons = {
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>',
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>',
    target:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path></svg>'
  };

  try {
    liveSnapshot = JSON.parse(fastClickPresentDataScript.textContent || "{}");
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

  const formatCountdown = (deadlineAt) => {
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

  const renderIcon = (iconName) => presentIcons[iconName] || presentIcons.spark;

  const renderMetaChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="quiz-present-meta-chip ${extraClass}">
      <span class="quiz-present-chip-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="quiz-present-meta-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;

  const renderStage = ({ iconName, label, title, description = "", chips = [], body = "", stageClass = "" }) => `
    <section class="quiz-present-stage ${stageClass}">
      <header class="quiz-present-header">
        <div class="quiz-present-brandline">
          <span class="quiz-present-icon-badge" aria-hidden="true">${renderIcon(iconName)}</span>
          <div class="quiz-present-brand-copy">
            <span class="section-pill">${escapeHtml(label)}</span>
            <span class="quiz-present-brand-hint">Kuizzosh live screen</span>
          </div>
        </div>
        ${chips.length ? `<div class="quiz-present-meta-row">${chips.join("")}</div>` : ""}
      </header>
      <div class="quiz-present-headline">
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>
      ${body}
    </section>
  `;

  const renderParticipantCloud = (snapshot) => {
    if (!snapshot.participants?.length) {
      return '<p class="fast-click-empty-note">Waiting for players to join the room.</p>';
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
      return '<p class="fast-click-empty-note">Ranking will appear as soon as players tap on green.</p>';
    }

    return `
      <div class="fast-click-rank-list">
        ${snapshot.leaderboard
          .slice(0, 10)
          .map(
            (entry) => `
              <article class="fast-click-rank-row ${entry.rank === 1 ? "is-active" : ""}">
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

  const renderLobby = (snapshot) =>
    renderStage({
      iconName: "spark",
      label: "Fast Click Lobby",
      title: snapshot.room?.title || "Fast Click",
      description: "Players join now, wait for the countdown, then race to tap the moment the signal turns green.",
      chips: [
        renderMetaChip("users", "Players ready", String(snapshot.participantCount || 0)),
        renderMetaChip("target", "Room code", snapshot.room?.roomCode || "")
      ],
      body: `
        <div class="fast-click-stage-grid fast-click-stage-grid-present">
          <article class="fast-click-stage-card is-dark is-emphasis">
            <div class="fast-click-stage-copy">
              <span class="section-pill">Room Code</span>
              <h2 class="fast-click-present-code">${escapeHtml(snapshot.room?.roomCode || "")}</h2>
              <p>The code stays visible here while the lobby is open so everyone can join fast.</p>
            </div>
          </article>

          <article class="fast-click-stage-card is-dark">
            <div class="fast-click-stage-copy">
              <span class="section-pill">Players Joined</span>
              <h2>${escapeHtml(String(snapshot.participantCount || 0))}</h2>
              <p>Everyone in the room will be listed here before the signal starts.</p>
            </div>
            ${renderParticipantCloud(snapshot)}
          </article>
        </div>
      `,
      stageClass: "fast-click-present-stage"
    });

  const renderLiveStage = (snapshot) => {
    const isCountdown = snapshot.status === "countdown";
    const isRed = snapshot.status === "red";
    const isGreen = snapshot.status === "green";
    const isFinished = snapshot.status === "finished";
    const winner = snapshot.leaderboard?.[0] || null;
    const title = isCountdown
      ? "Countdown"
      : isRed
        ? "Wait for green"
        : isGreen
          ? "Tap now"
          : "Fastest reactions";
    const description = isCountdown
      ? "Players are in the final countdown before the red signal appears."
      : isRed
        ? "Nobody should click yet. The valid tap window starts only when green appears."
        : isGreen
          ? "The signal is live now. Ranking updates with every valid click."
          : "Final ranking ordered from the fastest valid reaction to the slowest.";

    return renderStage({
      iconName: isFinished ? "trophy" : isGreen ? "pulse" : "clock",
      label: isFinished ? "Round Finished" : "Fast Click Live",
      title,
      description,
      chips: [
        renderMetaChip("users", "Players", String(snapshot.participantCount || 0)),
        renderMetaChip("pulse", "Clicked", String(snapshot.clickedCount || 0)),
        renderMetaChip(
          isGreen || isFinished ? "trophy" : "clock",
          isGreen ? "Still waiting" : isFinished ? "Best time" : "Time left",
          isGreen
            ? String(snapshot.remainingCount || 0)
            : isFinished
              ? winner?.reactionTimeLabel || "--"
              : formatCountdown(snapshot.phaseEndsAt),
          !isGreen && !isFinished ? "quiz-present-meta-chip-countdown" : "",
          !isGreen && !isFinished ? 'data-fast-click-present-countdown=""' : ""
        )
      ],
      body: `
        <div class="fast-click-stage-grid fast-click-stage-grid-present">
          <article class="fast-click-stage-card is-dark is-emphasis">
            <div class="fast-click-signal-wrap">
              <span class="section-pill">${escapeHtml(isFinished ? "Winner" : isGreen ? "Green Signal" : isRed ? "Red Signal" : "Countdown")}</span>
              ${
                isCountdown
                  ? `<div class="fast-click-countdown-number" data-fast-click-present-big-countdown>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>`
                  : isFinished
                    ? `
                      <div class="fast-click-result-highlight">
                        <h2>${escapeHtml(winner?.displayName || "Waiting")}</h2>
                        <div class="fast-click-result-time">${escapeHtml(winner?.reactionTimeLabel || "--")}</div>
                        <p>${escapeHtml(`${snapshot.clickedCount || 0} players recorded a reaction time.`)}</p>
                      </div>
                    `
                    : `<div class="fast-click-signal-light ${isRed ? "is-red" : "is-green"}"></div>`
              }
            </div>
          </article>

          <article class="fast-click-stage-card is-dark">
            <div class="fast-click-stage-copy">
              <span class="section-pill">Top 10</span>
              <h2>Live ranking</h2>
              <p>Ranking is based on the fastest valid click after the signal turns green.</p>
            </div>
            ${renderLeaderboard(snapshot)}
          </article>
        </div>
      `,
      stageClass: "fast-click-present-stage"
    });
  };

  const render = (snapshot) => {
    liveSnapshot = snapshot || {};
    syncServerClock(liveSnapshot);
    ensureRealtimeSubscription(liveSnapshot.sessionId).catch(() => {});
    fastClickPresentShell.innerHTML =
      liveSnapshot.status === "lobby"
        ? renderLobby(liveSnapshot)
        : renderLiveStage(liveSnapshot);
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
      return;
    }

    const payload = await response.json();

    if (payload.snapshot) {
      boundarySyncKey = "";
      render(payload.snapshot);
    }
  };

  render(liveSnapshot);

  window.setInterval(() => {
    loadState().catch(() => {});
  }, STATE_POLL_INTERVAL_MS);

  window.setInterval(() => {
    fastClickPresentShell.querySelectorAll("[data-fast-click-present-countdown]").forEach((node) => {
      node.textContent = formatCountdown(liveSnapshot.phaseEndsAt);
    });

    fastClickPresentShell.querySelectorAll("[data-fast-click-present-big-countdown]").forEach((node) => {
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
